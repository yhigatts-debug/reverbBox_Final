export const ALGO_COLORS = { 
  lexicon: '#60a5fa', 
  bricasti: '#fbbf24', 
  tcelectronic: '#10b981' 
} as const;

// Renamed 'tc' to 'tcelectronic' for system consistency
export const ENGINE_THEMES = {
  lexicon: {
    label: 'LEXICON LUSH',
    color: 'text-blue-400',
    border: 'border-blue-500',
    bg: 'bg-blue-500/10',
    icon: '✨'
  },
  bricasti: {
    label: 'BRICASTI M7',
    color: 'text-amber-400',
    border: 'border-amber-500',
    bg: 'bg-amber-500/10',
    icon: '🏛️'
  },
  tcelectronic: {
    label: 'VSS3 CORE',
    color: 'text-emerald-400',
    border: 'border-emerald-500',
    bg: 'bg-emerald-500/10',
    icon: '🌬️'
  }
} as const;