import { describe, expect, it } from "vitest"
import { toolEnv } from "../src/toolEnv"

describe("what a tool can see", () => {
  it("hides the keys and settings of this project, whatever loaded them", () => {
    const seen = toolEnv({
      DEMO_MNEMONIC: "x",
      CEASENET_AGENT_KEY: "x",
      CEASENET_HOME: "x",
      ARKIV_ACCESS_KEY: "x",
      WORLD_IDP_CLIENT_SECRET: "x",
      WORLD_RP_SIGNING_KEY: "x",
      MODEL_API_KEY: "x",
      ZG_API_KEY: "x",
      SWARM_POSTAGE_BATCH_ID: "x",
      BEE_API_URL: "x",
      model_api_key: "x",
    })
    expect(seen).toEqual({})
  })

  it("leaves everything else alone, including the tool's own settings", () => {
    const env = { PATH: "/bin", GITHUB_TOKEN: "t", DEMO_SANDBOX: "/s" }
    expect(toolEnv(env)).toEqual(env)
  })
})
