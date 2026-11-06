/**
 * Trigonometry that gives the same bits in every JavaScript engine.
 *
 * JavaScript leaves Math.atan2, Math.acos and Math.hypot free to differ in their last digit between
 * engines, and Chrome and Node really do differ. One tiny difference in a joint target changes every
 * physics state after it, which would make an honest log look altered during replay.
 *
 * Addition, subtraction, multiplication, division and square root are exact by specification, so this uses
 * nothing else. It follows the classic fdlibm arctangent.
 */

const ATAN_HI = [4.6364760900080609e-1, 7.8539816339744828e-1, 9.8279372324732905e-1, 1.5707963267948966] as const
const ATAN_LO = [2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17] as const
const AT = [
  3.3333333333332932e-1, -1.9999999999876483e-1, 1.4285714272503466e-1, -1.1111110405462356e-1, 9.0908871334365066e-2,
  -7.6918762050448300e-2, 6.6610731373875312e-2, -5.8335701337905735e-2, 4.9768779946159324e-2, -3.6531572744216916e-2,
  1.6285820115365782e-2,
] as const

const PI = 3.141592653589793

function exactAtan(value: number): number {
  const negative = value < 0
  let x = negative ? -value : value
  let id = -1
  if (x >= 7 / 16) {
    if (x < 11 / 16) {
      id = 0
      x = (2 * x - 1) / (2 + x)
    } else if (x < 19 / 16) {
      id = 1
      x = (x - 1) / (x + 1)
    } else if (x < 39 / 16) {
      id = 2
      x = (x - 1.5) / (1 + 1.5 * x)
    } else {
      id = 3
      x = -1 / x
    }
  }
  const z = x * x
  const w = z * z
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))))
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))))
  if (id < 0) return negative ? -(x - x * (s1 + s2)) : x - x * (s1 + s2)
  const result = ATAN_HI[id as 0]! - (x * (s1 + s2) - ATAN_LO[id as 0]! - x)
  return negative ? -result : result
}

export function exactAtan2(y: number, x: number): number {
  if (x > 0) return exactAtan(y / x)
  if (x < 0) return y >= 0 ? exactAtan(y / x) + PI : exactAtan(y / x) - PI
  if (y > 0) return PI / 2
  if (y < 0) return -PI / 2
  return 0
}

/** Arccosine for a value already limited to between -1 and 1. */
export function exactAcos(c: number): number {
  return exactAtan2(Math.sqrt(1 - c * c), c)
}

export function exactHypot(a: number, b: number): number {
  return Math.sqrt(a * a + b * b)
}
