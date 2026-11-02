// @ate/mcp — frozen tool schemas (§7.4) + stub server (§21.4). Lane B adds the real server here.
export { TOOL_DEFINITIONS, TOOL_LIST, type ToolDefinition, type ToolAnnotations } from "./schemas.js";
export { validateToolInput, type ValidationResult } from "./validate.js";
export { createStubHandler, InvalidParamsError, UnknownToolError, type StubHandler, type StubOptions } from "./stub/handler.js";
export { createStubServer, stubOptionsFromEnv, STUB_SERVER_NAME, STUB_SERVER_VERSION } from "./stub/server.js";
