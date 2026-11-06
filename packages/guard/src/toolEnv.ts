/**
 * Settings a tool's own process must never see, including anything this project's .env may have loaded: the agent's
 * key, the model's key, access keys and the wallet phrase. Windows does not care about the case of these names.
 */
const HIDDEN_FROM_TOOL = /^(CEASENET_|ARKIV_|WORLD_|MODEL_|ZG_|SWARM_|BEE_|DEMO_MNEMONIC$)/i

/** What a tool gets to see. Its own settings, such as a token its maker asks for, still reach it. */
export const toolEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([name]) => !HIDDEN_FROM_TOOL.test(name)))
