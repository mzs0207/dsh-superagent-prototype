import { createRoot } from 'react-dom/client'
import { en, zh, type DshSuperagentKey } from '../client/locales.ts'
import STYLES from '../client/client.css?raw'
import THEME from './theme.css?raw'
import { RemotePage } from './page.tsx'

const language = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
document.documentElement.lang = language
const dictionary = language === 'zh' ? zh : en
const t = (key: DshSuperagentKey, params?: Record<string, unknown>) => {
  const text = dictionary[key]
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(params, name) ? String(params[name]) : match) : text
}
document.title = t('tab.remote')
createRoot(document.getElementById('environment-resources')!).render(<>
  <style>{STYLES + THEME}</style>
  <main className="dt-page"><div className="dt-column"><RemotePage t={t} /></div></main>
</>)
