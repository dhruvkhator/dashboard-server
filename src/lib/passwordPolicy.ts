export type PasswordPolicyResult = { ok: true } | { ok: false; errors: string[] };

const COMMON_WEAK = new Set<string>([
  'password', 'password1', '12345678', '123456789', 'qwerty', 'letmein', 'welcome'
]);

export function validatePasswordPolicy(password: string, email?: string | null): PasswordPolicyResult {
  const errors: string[] = [];
  const local = (email || '').split('@')[0]?.toLowerCase?.() || '';
  if (password.length < 10) errors.push('min_length_10');
  if (!/[a-z]/.test(password)) errors.push('require_lower');
  if (!/[A-Z]/.test(password)) errors.push('require_upper');
  if (!/\d/.test(password)) errors.push('require_digit');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('require_symbol');
  if (!/^\S+$/.test(password)) errors.push('no_whitespace');
  if (local && password.toLowerCase().includes(local)) errors.push('contains_email_local');
  if (COMMON_WEAK.has(password.toLowerCase())) errors.push('common_password');
  return errors.length ? { ok: false, errors } : { ok: true };
}

