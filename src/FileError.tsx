import type { IntakeProblem } from './checkExport'
import { useLanguage } from './language.ts'

/**
 * The intake's refusal: announced at once (role="alert"), sitting right above
 * the button that fixes it.
 *
 * What went wrong and what to do about it are worded in the catalogue
 * (`fileError.message` in src/i18n), one whole message per problem and per
 * language. Every message ends in an action, because "invalid file" on its
 * own is a dead end.
 */
export function FileError({ problem, fileName }: { problem: IntakeProblem; fileName: string | null }) {
  const { t } = useLanguage()
  const message = t.fileError.message(problem, fileName)
  return (
    <div className="file-error" role="alert">
      <p className="file-error-label">{t.fileError.label}</p>
      <p className="file-error-title">{message.title}</p>
      <p className="file-error-body">{message.body}</p>
      {message.snippet && (
        <p className="file-error-snippet">
          <span className="file-error-snippet-label">{message.snippet.label}</span>
          <code>{message.snippet.text}</code>
        </p>
      )}
      <p className="file-error-fix">{message.fix}</p>
    </div>
  )
}
