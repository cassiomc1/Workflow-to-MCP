export const sensitiveName =
  /pass(word|code)?|secret|token|auth|session|cookie|api.?key|credit|card|cvc|cvv|iban|ssn|one.?time|otp|payment|cc[-_]|iban|security.?code|pin(?:$|[_-])/i;
export function secretLike(value: string): boolean {
  return (
    /(?:bearer\s+|eyJ[a-zA-Z0-9_-]+\.|(?:sk|ghp|github_pat|AKIA)[-_a-zA-Z0-9]{12,}|[a-zA-Z0-9+/_=-]{32,})/i.test(
      value,
    ) || /(?:password|token|secret|authorization)\s*[:=]/i.test(value)
  );
}
