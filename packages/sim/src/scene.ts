/** Layout of one work cell, in metres. The arm stands at the origin and the table is in front of it. */
export const TABLE_TOP = 0.2
export const BOX_SIZE = 0.05
export const BOX_COUNT = 4

/** Where boxes can sit. Slots 0 to 3 are side A, slots 4 to 7 are side B. */
export const SLOTS: ReadonlyArray<readonly [number, number]> = [
  [0.42, 0.3],
  [0.54, 0.3],
  [0.42, 0.18],
  [0.54, 0.18],
  [0.42, -0.3],
  [0.54, -0.3],
  [0.42, -0.18],
  [0.54, -0.18],
]

/** The safe tray where a stopping robot puts down whatever it is holding. */
export const TRAY: ReadonlyArray<readonly [number, number]> = [
  [0.42, 0],
  [0.54, 0],
]

export const LINK = 0.36
export const SHOULDER_HEIGHT = 0.3
export const TOOL_LENGTH = 0.12

function box(i: number): string {
  const [x, y] = SLOTS[i]!
  const hue = ["0.91 0.42 0.17", "0.2 0.55 0.86", "0.27 0.7 0.42", "0.72 0.42 0.82"][i]
  return `
    <body name="box${i}" pos="${x} ${y} ${TABLE_TOP + BOX_SIZE / 2 + 0.001}">
      <freejoint name="box${i}"/>
      <geom name="box${i}" type="box" size="${BOX_SIZE / 2} ${BOX_SIZE / 2} ${BOX_SIZE / 2}" mass="0.15" rgba="${hue} 1" friction="1.2 0.02 0.001" contype="1" conaffinity="1"/>
    </body>`
}

/** One arm, one table, four boxes. Every robot runs its own copy, so runs can be replayed exactly. */
export const SCENE_XML = `
<mujoco model="ceasenet-cell">
  <compiler angle="radian"/>
  <option timestep="0.002" integrator="implicitfast"/>
  <default>
    <geom contype="0" conaffinity="0"/>
    <joint damping="4" armature="0.02"/>
    <position kp="500" dampratio="1" forcelimited="true" forcerange="-90 90"/>
  </default>
  <worldbody>
    <geom name="floor" type="plane" size="1.2 1.2 0.05" pos="0.25 0 0" rgba="0.15 0.17 0.21 1" contype="1" conaffinity="1"/>
    <geom name="table" type="box" size="0.17 0.42 ${TABLE_TOP / 2}" pos="0.48 0 ${TABLE_TOP / 2}" rgba="0.36 0.38 0.43 1" contype="1" conaffinity="1"/>
    <geom name="sideA" type="box" size="0.14 0.13 0.001" pos="0.48 0.24 ${TABLE_TOP + 0.0005}" rgba="0.24 0.32 0.46 1"/>
    <geom name="sideB" type="box" size="0.14 0.13 0.001" pos="0.48 -0.24 ${TABLE_TOP + 0.0005}" rgba="0.2 0.38 0.34 1"/>
    <geom name="tray" type="box" size="0.14 0.06 0.002" pos="0.48 0 ${TABLE_TOP + 0.001}" rgba="0.75 0.58 0.16 1"/>
    <geom name="pedestal" type="cylinder" size="0.09 0.125" pos="0 0 0.125" rgba="0.2 0.22 0.27 1"/>
    <geom name="led" type="sphere" size="0.035" pos="-0.1 0 0.21" rgba="0.2 0.8 0.4 1"/>
    <body name="waist" pos="0 0 0.25" gravcomp="1">
      <joint name="waist" type="hinge" axis="0 0 1" range="-3.14 3.14"/>
      <geom name="turret" type="cylinder" size="0.075 0.03" pos="0 0 0.02" mass="2" rgba="0.92 0.55 0.13 1"/>
      <body name="upper" pos="0 0 0.05" gravcomp="1">
        <joint name="shoulder" type="hinge" axis="0 1 0" range="-1.8 1.8"/>
        <geom name="upperLink" type="capsule" size="0.04" fromto="0 0 0 0 0 ${LINK}" mass="1.5" rgba="0.92 0.55 0.13 1"/>
        <body name="fore" pos="0 0 ${LINK}" gravcomp="1">
          <joint name="elbow" type="hinge" axis="0 1 0" range="0 2.9"/>
          <geom name="foreLink" type="capsule" size="0.032" fromto="0 0 0 0 0 ${LINK}" mass="1" rgba="0.96 0.96 0.96 1"/>
          <body name="wrist" pos="0 0 ${LINK}" gravcomp="1">
            <joint name="wrist" type="hinge" axis="0 1 0" range="-4.5 4.5"/>
            <geom name="toolLink" type="capsule" size="0.02" fromto="0 0 0 0 0 ${-(TOOL_LENGTH - 0.02)}" mass="0.3" rgba="0.3 0.32 0.38 1"/>
            <geom name="gripper" type="box" size="0.035 0.035 0.012" pos="0 0 ${-(TOOL_LENGTH - 0.012)}" mass="0.1" rgba="0.3 0.32 0.38 1"/>
            <site name="tip" pos="0 0 ${-TOOL_LENGTH}"/>
          </body>
        </body>
      </body>
    </body>${[0, 1, 2, 3].map(box).join("")}
  </worldbody>
  <actuator>
    <position name="waist" joint="waist"/>
    <position name="shoulder" joint="shoulder"/>
    <position name="elbow" joint="elbow"/>
    <position name="wrist" joint="wrist"/>
  </actuator>
</mujoco>`
