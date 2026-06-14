"""
ROS2 bridge — makes the Waveshare rover a first-class ROS2 node so Nav2 /
Isaac ROS (cuVSLAM + Nvblox) can drive it and consume its odometry.

    Nav2 / teleop  --/cmd_vel (Twist)-->  [this node]  --> wheels (T:13 mix)
    wheel encoders --------------------->  [this node]  --/odom + /tf-->  Nav2

Two motion backends (same as dimos_rover.py, no new serial contention):
  DRIVE_MODE=http   (default) POST api.py /drive — api owns the single serial.
  DRIVE_MODE=serial open the ESP32 directly (ONLY when api.py is not running).

The math is split into pure, dependency-free helpers (twist_to_wheels reused
from dimos_rover; OdomIntegrator below) so they unit-test without rclpy or a
robot. The rclpy node is built lazily so `import ros2_bridge` works anywhere.

Run on the Jetson (ROS2 + rclpy sourced):
    DRIVE_MODE=http python ros2_bridge.py
Then point Nav2 at /cmd_vel + /odom (see the isaac_perceptor tutorial).
"""
import math
import os
import time

# Reuse the exact (v,w)->wheels mix + clamp the DimOS body adapter already uses,
# so HTTP-mode wheel commands are identical whether DimOS or Nav2 is driving.
from dimos_rover import twist_to_wheels, make_backend, WHEEL_BASE, MAX_SPEED

# Metres of ground travel per encoder tick (odl/odr). The firmware counters are
# unit-less here; calibrate by driving a measured 1.0 m and dividing by Δticks.
ODOM_SCALE = float(os.environ.get("ROVER_ODOM_SCALE", "0.0001"))
CMD_TIMEOUT = float(os.environ.get("ROVER_CMD_TIMEOUT", "0.5"))   # deadman stop


class OdomIntegrator:
    """Differential-drive dead-reckoning from cumulative wheel encoder counts.

    Pure + stateful: feed it raw (odl, odr) ticks each cycle, it returns the
    integrated (x, y, theta) pose in the odom frame. First sample only seeds the
    baseline (no jump). Heading comes from the wheel difference; optionally fuse
    an absolute yaw (radians) when the IMU is trustworthy on the unit.
    """

    def __init__(self, scale=ODOM_SCALE, wheel_base=WHEEL_BASE):
        self.scale = scale
        self.wheel_base = wheel_base
        self.x = self.y = self.theta = 0.0
        self._l = self._r = None

    def update(self, odl, odr, yaw=None):
        if odl is None or odr is None:
            return self.x, self.y, self.theta
        if self._l is None:                      # seed baseline, emit no motion
            self._l, self._r = odl, odr
            return self.x, self.y, self.theta
        dl = (odl - self._l) * self.scale
        dr = (odr - self._r) * self.scale
        self._l, self._r = odl, odr
        dc = (dl + dr) / 2.0
        if yaw is not None:                      # trust absolute heading if given
            self.theta = yaw
        else:
            self.theta += (dr - dl) / self.wheel_base
            self.theta = math.atan2(math.sin(self.theta), math.cos(self.theta))
        self.x += dc * math.cos(self.theta)
        self.y += dc * math.sin(self.theta)
        return self.x, self.y, self.theta


def _odom_source(backend):
    """Return a callable -> (odl, odr) using whichever backend we have.
    HTTP mode reads api.py /telemetry; serial mode reads the Rover directly."""
    if hasattr(backend, "odometry"):
        def read():
            o = backend.odometry()
            return o.get("odl"), o.get("odr")
        return read
    return lambda: (None, None)


# --- rclpy node (built lazily so this file imports without ROS2) -------------
def build_node():
    import rclpy
    from rclpy.node import Node
    from geometry_msgs.msg import Twist, TransformStamped
    from nav_msgs.msg import Odometry
    from tf2_ros import TransformBroadcaster

    def yaw_to_quat(yaw):
        return (0.0, 0.0, math.sin(yaw / 2.0), math.cos(yaw / 2.0))

    class RoverBridge(Node):
        def __init__(self):
            super().__init__("rover_bridge")
            self._drive = make_backend()
            self._read_odom = _odom_source(self._drive)
            self._odom = OdomIntegrator()
            self._last_cmd = 0.0

            self.create_subscription(Twist, "cmd_vel", self._on_cmd_vel, 10)
            self._odom_pub = self.create_publisher(Odometry, "odom", 10)
            self._tf = TransformBroadcaster(self)
            self.create_timer(0.05, self._watchdog)      # 20 Hz deadman
            self.create_timer(0.05, self._publish_odom)   # 20 Hz odom/tf
            self.get_logger().info(
                f"rover_bridge up: DRIVE_MODE={os.environ.get('DRIVE_MODE','http')} "
                f"max={MAX_SPEED} base={WHEEL_BASE} odom_scale={ODOM_SCALE}")

        def _on_cmd_vel(self, msg):
            # native firmware mix when on serial; wheel commands over HTTP.
            if hasattr(self._drive, "drive_xz"):
                self._drive.drive_xz(msg.linear.x, msg.angular.z)
            else:
                l, r = twist_to_wheels(msg.linear.x, msg.angular.z)
                self._drive.drive(l, r)
            self._last_cmd = time.time()

        def _watchdog(self):
            if time.time() - self._last_cmd > CMD_TIMEOUT:
                self._drive.stop()

        def _publish_odom(self):
            odl, odr = self._read_odom()
            x, y, th = self._odom.update(odl, odr)
            now = self.get_clock().now().to_msg()
            qx, qy, qz, qw = yaw_to_quat(th)

            t = TransformStamped()
            t.header.stamp = now
            t.header.frame_id = "odom"
            t.child_frame_id = "base_link"
            t.transform.translation.x = x
            t.transform.translation.y = y
            t.transform.rotation.x, t.transform.rotation.y = qx, qy
            t.transform.rotation.z, t.transform.rotation.w = qz, qw
            self._tf.sendTransform(t)

            o = Odometry()
            o.header.stamp = now
            o.header.frame_id = "odom"
            o.child_frame_id = "base_link"
            o.pose.pose.position.x = x
            o.pose.pose.position.y = y
            o.pose.pose.orientation.x, o.pose.pose.orientation.y = qx, qy
            o.pose.pose.orientation.z, o.pose.pose.orientation.w = qz, qw
            self._odom_pub.publish(o)

    return rclpy, RoverBridge


def main():
    rclpy, RoverBridge = build_node()
    rclpy.init()
    node = RoverBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            node._drive.stop()
        except Exception:
            pass
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
