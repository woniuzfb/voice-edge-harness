/**
 * Auto-registering entrypoint for VEH runtime environment and filesystem interceptor.
 *
 * Import this module at startup to activate VEH isolation:
 * ```ts
 * import '@deepseek-ai/dsh-voice-edge/register'
 * ```
 *
 * @module @deepseek-ai/dsh-voice-edge/register
 */

import { installVehInterceptor } from './interceptor.ts'

installVehInterceptor()
