import {
  Box,
  Button,
  FormControlLabel,
  Slider,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';
import type { Projection } from '../render3d/camera';
import type { ClipBox } from '../render3d/clipping';
import { TRANSFER_PRESETS } from '../render3d/transferFunctions';
import type { RenderMode } from '../render3d/VolumeRenderer';
import type { Coordinate } from '../utils/canvasMath';
import type { PlaneOrientation } from '../utils/mprSampler';

export type RenderQuality = 'fast' | 'standard' | 'high';

export interface VolumeRenderSettings {
  mode: RenderMode;
  presetId: string;
  // Moves the transfer function along the HU axis.
  shiftHu: number;
  opacityScale: number;
  shading: boolean;
  // Surface threshold in real units; null until set, for the volume's default.
  isoValue: number | null;
  projection: Projection;
  quality: RenderQuality;
  clipBox: ClipBox;
  cutPlane: PlaneOrientation | 'none';
  flipCut: boolean;
  showMprPlanes: boolean;
  // VR colours samples inside visible segments.
  labelTint: boolean;
}

export const MIN_SHIFT_HU = -500;
export const MAX_SHIFT_HU = 500;
export const MIN_OPACITY_SCALE = 0.1;
export const MAX_OPACITY_SCALE = 4;

const AXIS_LABELS: Record<keyof Coordinate, string> = { x: 'Right–Left', y: 'Anterior–Posterior', z: 'Inferior–Superior' };

interface VolumeRenderControlsProps {
  settings: VolumeRenderSettings;
  // Threshold in use and the volume's value range, in real units.
  isoValue: number;
  valueRange: [number, number];
  units: string;
  // Presets need Hounsfield units; other data ramps opacity across the shared window instead.
  hounsfield: boolean;
  // Segment modes need a loaded segmentation.
  hasSegmentation: boolean;
  surfaceOpacity: number;
  onSurfaceOpacityChange: (opacity: number) => void;
  onChange: (update: Partial<VolumeRenderSettings>) => void;
  onResetView: () => void;
}

function formatValue(value: number, units: string): string {
  const text = Math.abs(value) >= 100 || Number.isInteger(value) ? `${Math.round(value)}` : value.toPrecision(3);
  return units ? `${text} ${units}` : text;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {title}
      </Typography>
      {children}
    </Box>
  );
}

export function VolumeRenderControls({
  settings,
  isoValue,
  valueRange,
  units,
  hounsfield,
  hasSegmentation,
  surfaceOpacity,
  onSurfaceOpacityChange,
  onChange,
  onResetView,
}: VolumeRenderControlsProps) {
  const isoStep = valueRange[1] - valueRange[0] > 200 ? 1 : (valueRange[1] - valueRange[0]) / 200;
  const { mode, clipBox } = settings;
  const setClip = (axis: keyof Coordinate, [lo, hi]: number[]) =>
    onChange({
      clipBox: {
        min: { ...clipBox.min, [axis]: lo / 100 },
        max: { ...clipBox.max, [axis]: hi / 100 },
      },
    });

  return (
    <Box sx={{ width: 300, display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'left' }}>
      <Section title="Mode">
        <ToggleButtonGroup
          exclusive
          size="small"
          value={mode}
          onChange={(_, value: RenderMode | null) => value && onChange({ mode: value })}
        >
          <ToggleButton value="dvr">VR</ToggleButton>
          <ToggleButton value="iso">Surface</ToggleButton>
          <ToggleButton value="mip">MIP</ToggleButton>
          <ToggleButton value="minip">MinIP</ToggleButton>
          <ToggleButton value="average">Avg</ToggleButton>
          <ToggleButton value="labels" disabled={!hasSegmentation} title="Surfaces of the visible segments">
            Seg
          </ToggleButton>
        </ToggleButtonGroup>
      </Section>

      {mode === 'labels' && (
        <Section title={`Segment opacity: ${Math.round(surfaceOpacity * 100)}%`}>
          <Slider
            size="small"
            min={0.1}
            max={1}
            step={0.05}
            value={surfaceOpacity}
            onChange={(_, value) => onSurfaceOpacityChange(value as number)}
          />
        </Section>
      )}

      {mode === 'dvr' && hasSegmentation && (
        <FormControlLabel
          control={<Switch size="small" checked={settings.labelTint} onChange={(_, checked) => onChange({ labelTint: checked })} />}
          label="Colour by segment"
        />
      )}

      {mode === 'dvr' && !hounsfield && (
        <>
          <Typography variant="body2" color="text.secondary">
            No Hounsfield scale: opacity ramps across the shared window level/width.
          </Typography>
          <Section title={`Opacity: ×${settings.opacityScale.toFixed(2)}`}>
            <Slider
              size="small"
              min={MIN_OPACITY_SCALE}
              max={MAX_OPACITY_SCALE}
              step={0.05}
              value={settings.opacityScale}
              onChange={(_, value) => onChange({ opacityScale: value as number })}
            />
          </Section>
          <FormControlLabel
            control={<Switch size="small" checked={settings.shading} onChange={(_, checked) => onChange({ shading: checked })} />}
            label="Shading"
          />
        </>
      )}

      {mode === 'dvr' && hounsfield && (
        <>
          <Section title="Preset">
            <ToggleButtonGroup
              exclusive
              size="small"
              value={settings.presetId}
              onChange={(_, value: string | null) => value && onChange({ presetId: value, shiftHu: 0, opacityScale: 1 })}
              sx={{ flexWrap: 'wrap' }}
            >
              {TRANSFER_PRESETS.map((preset) => (
                <ToggleButton key={preset.id} value={preset.id}>
                  {preset.name}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Section>
          <Section title={`Shift: ${settings.shiftHu} HU`}>
            <Slider
              size="small"
              min={MIN_SHIFT_HU}
              max={MAX_SHIFT_HU}
              value={settings.shiftHu}
              onChange={(_, value) => onChange({ shiftHu: value as number })}
            />
          </Section>
          <Section title={`Opacity: ×${settings.opacityScale.toFixed(2)}`}>
            <Slider
              size="small"
              min={MIN_OPACITY_SCALE}
              max={MAX_OPACITY_SCALE}
              step={0.05}
              value={settings.opacityScale}
              onChange={(_, value) => onChange({ opacityScale: value as number })}
            />
          </Section>
          <FormControlLabel
            control={<Switch size="small" checked={settings.shading} onChange={(_, checked) => onChange({ shading: checked })} />}
            label="Shading"
          />
        </>
      )}

      {mode === 'iso' && (
        <Section title={`Threshold: ${formatValue(isoValue, units)}`}>
          <Slider
            size="small"
            min={valueRange[0]}
            max={valueRange[1]}
            step={isoStep}
            value={isoValue}
            onChange={(_, value) => onChange({ isoValue: value as number })}
          />
        </Section>
      )}

      {(mode === 'mip' || mode === 'minip' || mode === 'average') && (
        <Typography variant="body2" color="text.secondary">
          Uses the shared window level/width.
        </Typography>
      )}

      <Section title="Clip box (%)">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <Box key={axis} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" sx={{ width: 130 }}>
              {AXIS_LABELS[axis]}
            </Typography>
            <Slider
              size="small"
              min={0}
              max={100}
              disableSwap
              value={[Math.round(clipBox.min[axis] * 100), Math.round(clipBox.max[axis] * 100)]}
              onChange={(_, value) => setClip(axis, value as number[])}
            />
          </Box>
        ))}
      </Section>

      <Section title="Cut at MPR plane">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={settings.cutPlane}
            onChange={(_, value: VolumeRenderSettings['cutPlane'] | null) => value && onChange({ cutPlane: value })}
          >
            <ToggleButton value="none">None</ToggleButton>
            <ToggleButton value="axial">Ax</ToggleButton>
            <ToggleButton value="coronal">Cor</ToggleButton>
            <ToggleButton value="sagittal">Sag</ToggleButton>
          </ToggleButtonGroup>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={settings.flipCut}
                disabled={settings.cutPlane === 'none'}
                onChange={(_, checked) => onChange({ flipCut: checked })}
              />
            }
            label="Flip"
          />
        </Box>
      </Section>

      <Section title="View">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={settings.projection}
            onChange={(_, value: Projection | null) => value && onChange({ projection: value })}
          >
            <ToggleButton value="orthographic">Ortho</ToggleButton>
            <ToggleButton value="perspective">Persp</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={settings.quality}
            onChange={(_, value: RenderQuality | null) => value && onChange({ quality: value })}
          >
            <ToggleButton value="fast">Fast</ToggleButton>
            <ToggleButton value="standard">Std</ToggleButton>
            <ToggleButton value="high">High</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={settings.showMprPlanes}
                onChange={(_, checked) => onChange({ showMprPlanes: checked })}
              />
            }
            label="MPR planes"
          />
          <Button size="small" onClick={onResetView}>
            Reset view
          </Button>
        </Box>
      </Section>

      <Typography variant="caption" color="text.secondary">
        Left drag: rotate · Middle: pan · Right / wheel: zoom · Left+right: adjust (shift/opacity, threshold or W/L) ·
        Shift+click: move MPR crosshair · Double-click: reset view
      </Typography>
    </Box>
  );
}
