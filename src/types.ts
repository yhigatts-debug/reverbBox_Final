export interface AudioSettings {
  wetGain: number;
  wetPathDryGain: number;
  
  // Common parameters
  reverbDuration: number; // RT60
  reverbPreDelay: number;
  lowCut: number;
  highCut: number;
  masterGain: number;
  
  // Lexicon-style FDN
  lexSpin: number;
  lexWander: number;
  lexBassMult: number;
  
  // Bricasti-style Schroeder
  briDensity: number;
  briSize: number;
  briVRoll: number;
  briLfo: boolean;
  
  // TC Electronic-style FDN8
  tcAir: number;
  tcEarlyLate: number;
  tcHiDamp: number;
  tcLoDecay: number;
  tcMidDecay: number;

  isProcessing: boolean;
  bypassEffects: boolean;
  erKill: boolean; // Added for inspection
  algoMode: 'lexicon' | 'bricasti' | 'tcelectronic';

  // Room Simulation Metadata (Optional)
  roomAnalysis?: {
    room_volume?: number;
    listener_perceived_distance?: string;
    material_absorption_profile?: string;
  };
  roomDims?: {
    length?: number;
    width?: number;
    height?: number;
    material?: string;
  };
}

// Added missing AudioStats interface for services/audioService.ts
export interface AudioStats {
  rms: number;
  peak: number;
  stereoWidth: number;
  spectrum?: Uint8Array;
}

// Added missing ReverbParameters interface for components/ParameterDisplay.tsx
export interface ReverbParameters {
  dryGain: number;
  wetGain: number;
  reverbDuration: number;
  reverbPreDelay: number;
  highCut: number;
  lowCut: number;
  lexSpin: number;
  lexWander: number;
  lexBassMult: number;
  briDensity: number;
  briSize: number;
  briVRoll: number;
  briLfo: boolean;
  tcAir: number;
  tcEarlyLate: number;
  tcHiDamp: number;
  tcLoDecay: number;
  tcMidDecay: number;
}

export interface PresetSuggestion {
  name: string;
  description: string;
  settings: Partial<AudioSettings>;
}