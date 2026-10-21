export const en = {
  common: {
    language: 'Language',
    english: 'English',
    arabic: 'العربية',
    today: 'Today',
    yesterday: 'Yesterday'
  },
  welcome: {
    title: 'ATOMIC Studio',
    subtitle: 'An IDE where the agent can read, run and edit your project — and undo the whole run in one click.',
    cards: {
      openProject: {
        title: 'Open a project',
        desc: 'Point Studio at a folder already on this computer.'
      },
      newProject: {
        title: 'Start something new',
        desc: 'Scaffold an empty project, then describe what you want built.'
      },
      connectWorkspace: {
        title: 'Connect to a workspace',
        desc: 'Edit a folder on a server over SSH, or an ATOMIC workspace.'
      }
    },
    clone: {
      prompt: 'Have a repository URL?',
      action: 'Clone a repository…'
    },
    recent: {
      title: 'Recent',
      emptyTitle: 'Nothing here yet',
      emptySub: 'Folders you open appear here, most recent first.'
    },
    footer: {
      commandPalette: 'Everything else lives in the command palette.'
    }
  }
} as const

export type TranslationSchema = typeof en
export type Locale = 'en' | 'ar'
export type Direction = 'ltr' | 'rtl'
