import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { LanguageContext } from './language.ts'
import type { Language } from './language.ts'
import { Rich } from './Rich.tsx'

/**
 * Without this, one thrown render leaves a blank white page: React unmounts
 * the tree and the reader gets no message, no cause and no way back. A
 * malformed export producing an unexpected shape should cost a sentence, not
 * the whole app.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  // An error boundary has to be a class, and a class cannot call the
  // useLanguage() hook. `contextType` is the class way to read a context:
  // React fills in this.context from the nearest provider.
  static contextType = LanguageContext
  declare context: Language

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Nothing is reported anywhere — no analytics, no error service — so the
    // console is the only place this exists. That is the privacy trade.
    console.error('Loose Ends failed to render', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    const words = this.context.t.crash

    return (
      <main className="page">
        <header className="masthead">
          <h1>Loose Ends</h1>
        </header>
        <section className="intake">
          <h2>{words.heading}</h2>
          <p className="note">{words.what}</p>
          <p className="note">
            <Rich
              text={words.report}
              tags={{
                a: (label) => (
                  <a href="https://github.com/Karska-dev/LooseEnds/issues" target="_blank" rel="noopener noreferrer">
                    {label}
                  </a>
                ),
              }}
            />
          </p>
          <div className="actions">
            <button type="button" onClick={() => window.location.reload()}>
              {words.reload}
            </button>
          </div>
        </section>
      </main>
    )
  }
}
