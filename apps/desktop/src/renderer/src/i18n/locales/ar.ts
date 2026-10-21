import type { TranslationSchema } from './en'

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : string
}

export const ar: DeepPartial<TranslationSchema> = {
  common: {
    language: 'اللغة',
    english: 'English',
    arabic: 'العربية',
    today: 'اليوم',
    yesterday: 'أمس'
  },
  welcome: {
    title: 'ATOMIC Studio',
    subtitle: 'بيئة تطوير يقرأ فيها الوكيل مشروعك ويشغله ويعدله — ويتراجع عن الجلسة كاملة بنقرة واحدة.',
    cards: {
      openProject: {
        title: 'فتح مشروع',
        desc: 'وجّه أستوديو إلى مجلد موجود بالفعل على هذا الجهاز.'
      },
      newProject: {
        title: 'بدء مشروع جديد',
        desc: 'أنشئ هيكل مشروع جديد، ثم صِف ما تريد بناءه.'
      },
      connectWorkspace: {
        title: 'الاتصال ببيئة عمل',
        desc: 'تعديل مجلد على خادم عبر SSH، أو مساحة عمل ATOMIC.'
      }
    },
    clone: {
      prompt: 'هل لديك رابط مستودع؟',
      action: 'استنساخ مستودع…'
    },
    recent: {
      title: 'الأحدث',
      emptyTitle: 'لا يوجد شيء هنا بعد',
      emptySub: 'المجلدات التي تفتحها ستظهر هنا، الأحدث أولاً.'
    },
    footer: {
      commandPalette: 'كل شيء آخر تجده في لوحة الأوامر.'
    }
  }
}
