import React from 'react';
import { ReverbParameters } from '../types';
import { ENGINE_THEMES } from '../constants';

const Stat = ({ label, value }: { label: string, value: string }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[8px] text-zinc-500 font-mono font-bold uppercase tracking-widest">{label}</span>
    <span className="text-sm font-bold font-mono text-zinc-100">{value}</span>
  </div>
);

const EngineCard = ({ theme, badge, children }: { theme: any, badge: string, children?: React.ReactNode }) => (
  <div className={`bg-zinc-950 rounded-2xl border-t-2 ${theme.border} border-x border-b border-zinc-900 shadow-2xl overflow-hidden transition-all hover:border-opacity-100`}>
    <div className={`${theme.bg} px-4 py-3 border-b border-zinc-900 flex justify-between items-center`}>
      <div className="flex items-center gap-2">
        {theme.icon}
        <span className={`text-[10px] font-black tracking-tighter ${theme.color}`}>{theme.label}</span>
      </div>
      <span className="text-[8px] font-mono font-bold text-zinc-600 bg-zinc-900/50 px-2 py-0.5 rounded uppercase">{badge}</span>
    </div>
    <div className="p-4 space-y-3">
      {children}
    </div>
  </div>
);

const ParamRow = ({ label, value, color }: { label: string, value: string, color: string }) => (
  <div className="flex justify-between items-center group">
    <span className="text-[9px] text-zinc-500 font-mono uppercase tracking-tighter group-hover:text-zinc-400 transition-colors">{label}</span>
    <span className={`text-xs font-mono font-bold ${color}`}>{value}</span>
  </div>
);

interface ParameterDisplayProps {
  params: ReverbParameters;
}

const ParameterDisplay: React.FC<ParameterDisplayProps> = ({ params }) => {
  const formatVal = (val: any, unit: string = "") => {
    if (val === undefined || val === null) return "---";
    if (typeof val === 'number') {
      if (val >= 1000) return `${(val / 1000).toFixed(1)}k${unit}`;
      return `${val.toFixed(2)}${unit}`;
    }
    return String(val).toUpperCase();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-4 bg-zinc-950 rounded-xl border border-zinc-800 shadow-xl">
        <Stat label="DRY GAIN" value={formatVal(params.dryGain)} />
        <Stat label="WET GAIN" value={formatVal(params.wetGain)} />
        <Stat label="RT60" value={formatVal(params.reverbDuration, "s")} />
        <Stat label="PRE-DELAY" value={formatVal(params.reverbPreDelay, "s")} />
        <Stat label="HI-CUT" value={formatVal(params.highCut, "Hz")} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <EngineCard theme={ENGINE_THEMES.lexicon} badge="RANDOM HALL">
          <ParamRow label="SPIN (MOD)" value={formatVal(params.lexSpin)} color={ENGINE_THEMES.lexicon.color} />
          <ParamRow label="WANDER" value={formatVal(params.lexWander)} color={ENGINE_THEMES.lexicon.color} />
          <ParamRow label="BASS MULT" value={formatVal(params.lexBassMult)} color={ENGINE_THEMES.lexicon.color} />
          <ParamRow label="INPUT LO-CUT" value={formatVal(params.lowCut, "Hz")} color="text-zinc-500" />
        </EngineCard>

        <EngineCard theme={ENGINE_THEMES.bricasti} badge="V2 ALGO">
          <ParamRow label="DENSITY" value={formatVal(params.briDensity)} color={ENGINE_THEMES.bricasti.color} />
          <ParamRow label="DIFFUSION SIZE" value={formatVal(params.briSize)} color={ENGINE_THEMES.bricasti.color} />
          <ParamRow label="V-ROLL ROLLOFF" value={formatVal(params.briVRoll, "Hz")} color={ENGINE_THEMES.bricasti.color} />
          <ParamRow label="TIGHT LO-CUT" value={formatVal(params.lowCut, "Hz")} color="text-zinc-500" />
        </EngineCard>

        <EngineCard theme={ENGINE_THEMES.tcelectronic} badge="VSS3 SOURCE">
          <ParamRow label="AIR FREQ" value={formatVal(params.tcAir)} color={ENGINE_THEMES.tcelectronic.color} />
          <ParamRow label="EARLY/LATE RATIO" value={formatVal(params.tcEarlyLate)} color={ENGINE_THEMES.tcelectronic.color} />
          <ParamRow label="HI DAMPING" value={formatVal(params.tcHiDamp)} color={ENGINE_THEMES.tcelectronic.color} />
          <ParamRow label="TAIL LO-CUT" value={formatVal(params.lowCut, "Hz")} color="text-zinc-500" />
        </EngineCard>
      </div>
    </div>
  );
};

export default ParameterDisplay;