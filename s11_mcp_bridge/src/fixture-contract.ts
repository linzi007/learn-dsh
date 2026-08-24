/**
 * parent lab 与 child fixture 共用的静态名称，不含任何 server 启动副作用。
 * executable server 单独留在 local-fixture-server.ts，避免 import constants 时连接 stdin。
 */
export const RAW_LOOKUP_TOOL_NAME = 'course_lookup' as const
export const RAW_FAILURE_TOOL_NAME = 'course_fail' as const
