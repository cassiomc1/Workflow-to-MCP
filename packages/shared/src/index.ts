export const VERSION = "0.1.0";
export const POLICY_VERSION = "1";
export class WorkflowError extends Error {
  constructor(
    public code: string,
    public safeMessage = code,
    public stepId?: string,
  ) {
    super(safeMessage);
  }
}
export function fail(code: string, message = code): never {
  throw new WorkflowError(code, message);
}
export function safeError(error: unknown) {
  const e =
    error instanceof WorkflowError
      ? error
      : new WorkflowError(
          "INTERNAL_ERROR",
          "Operation failed; inspect local configuration and retry.",
        );
  return {
    code: e.code,
    message: e.safeMessage,
    ...(e.stepId ? { stepId: e.stepId } : {}),
    retryable: false,
    remediation:
      "Review the workflow, installation policy, and verification report. Never retry an uncertain write.",
  };
}
