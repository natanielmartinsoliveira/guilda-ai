import { MessageKey, t } from '../i18n';
type AuthKey =
  'invalid' | 'tooMany' | 'tooManyNow' | 'off' | 'needPassword' | 'needCode' | 'code' | 'newAccess';
/** Login messages (errors shown on the login screen, codes and notices sent on Telegram). */
export function authText(key: AuthKey, vars: Record<string, string | number> = {}) {
  return t(`auth.${key}` as MessageKey, vars);
}
