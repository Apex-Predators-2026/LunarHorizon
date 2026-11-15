import { PANEL_MODE_LABEL } from '../compare/scenario'
import type { PanelMode, SpacecraftConfig } from '../compare/types'

export function SpacecraftFields({ spacecraft, batteryHours, onChange, onBatteryHours, inputClass }: {
  spacecraft: SpacecraftConfig
  batteryHours: number
  onChange: (patch: Partial<SpacecraftConfig>) => void
  onBatteryHours: (hours: number) => void
  inputClass: string
}) {
  const endurance = spacecraft.battery_capacity_wh && spacecraft.average_load_w
    ? spacecraft.battery_capacity_wh / spacecraft.average_load_w : null

  return (
    <div className="space-y-2 text-xs">
      <label className="block">
        <span className="mb-0.5 block">Solar panel configuration</span>
        <select className={inputClass} value={spacecraft.panel_mode}
          onChange={(e) => onChange({ panel_mode: e.target.value as PanelMode })}>
          {Object.entries(PANEL_MODE_LABEL).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
        </select>
      </label>
      {spacecraft.panel_mode === 'vertical_fixed' && (
        <label className="block">
          <span className="mb-0.5 block">Panel faces azimuth (° from north)</span>
          <input type="number" min={0} max={359} className={inputClass} value={spacecraft.panel_azimuth_deg}
            onChange={(e) => onChange({ panel_azimuth_deg: ((Number(e.target.value) % 360) + 360) % 360 })} />
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="mb-0.5 block">Rated panel power (W)</span>
          <input type="number" min={0} className={inputClass} value={spacecraft.panel_rated_power_w ?? ''}
            onChange={(e) => onChange({ panel_rated_power_w: Number(e.target.value) || null })} />
        </label>
        <label>
          <span className="mb-0.5 block">Average load (W)</span>
          <input type="number" min={0} className={inputClass} value={spacecraft.average_load_w ?? ''}
            onChange={(e) => onChange({ average_load_w: Number(e.target.value) || null })} />
        </label>
      </div>
      <label className="block">
        <span className="mb-0.5 block">Battery capacity (Wh)</span>
        <input type="number" min={0} className={inputClass} value={spacecraft.battery_capacity_wh ?? ''}
          onChange={(e) => onChange({ battery_capacity_wh: Number(e.target.value) || null })} />
        {!!endurance && <span className="mt-0.5 block opacity-75">About {endurance.toFixed(0)} h at the average load</span>}
      </label>
      {!!endurance && Math.abs(endurance - batteryHours) > 0.5 && (
        <button type="button" className="text-[11px] font-medium underline underline-offset-2"
          onClick={() => onBatteryHours(Math.round(endurance))}>
          Use {Math.round(endurance)} h as the max acceptable darkness
        </button>
      )}
    </div>
  )
}
