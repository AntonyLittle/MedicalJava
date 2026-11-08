import { Box, Button, FormControlLabel, Slider, Switch, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { Volume } from '../api/types';
import type { SegmentationTool } from '../hooks/segmentationContext';
import { useSegmentation } from '../hooks/segmentationContext';
import {
  clearLabelJob,
  dilateJob,
  erodeJob,
  fillHolesJob,
  interpolateSlicesJob,
  keepLargestComponentJob,
  thresholdJob,
} from '../segmentation/algorithms';
import { realRange, toStoredValue, valueUnits } from '../utils/volumeValues';

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function formatValue(value: number, units: string): string {
  const text = Math.abs(value) >= 100 || Number.isInteger(value) ? `${Math.round(value)}` : value.toPrecision(3);
  return units ? `${text} ${units}` : text;
}

const TOOL_HELP: Record<SegmentationTool, string> = {
  navigate: 'Views navigate as usual.',
  brush: 'Left drag on a 2D view paints the active segment. Ctrl + drag pans.',
  eraser: 'Left drag on a 2D view erases the active segment. Ctrl + drag pans.',
  grow: 'Click on a 2D view to fill the connected region around that voxel (within the range, or the tolerance).',
};

// Painting tools and whole-segment operations for the active segment.
export function SegmentationTools({ volume }: { volume: Volume }) {
  const segmentation = useSegmentation();
  const [morphologyMm, setMorphologyMm] = useState(2);
  if (!segmentation?.session) return null;
  const { session, tools, setTools, display, setDisplay, busy, runEdit } = segmentation;
  const units = valueUnits(volume);
  const [minValue, maxValue] = realRange(volume);
  const valueStep = maxValue - minValue > 200 ? 1 : (maxValue - minValue) / 200;
  const label = session.activeLabel;
  const segment = session.activeSegment;
  const hasVoxels = label > 0 && session.labelmap.counts[label] > 0;
  const disabled = !!busy;
  const storedRange = () => ({ low: toStoredValue(volume, tools.range[0]), high: toStoredValue(volume, tools.range[1]) });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Section title="Tool">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={tools.tool}
            onChange={(_, value: SegmentationTool | null) => value && setTools({ tool: value })}
          >
            <ToggleButton value="navigate">Navigate</ToggleButton>
            <ToggleButton value="brush">Brush</ToggleButton>
            <ToggleButton value="eraser">Eraser</ToggleButton>
            <ToggleButton value="grow">Region grow</ToggleButton>
          </ToggleButtonGroup>
          <Button size="small" disabled={!session.canUndo || disabled} onClick={() => session.undo()}>
            Undo{session.undoDescription ? ` ${session.undoDescription.toLowerCase()}` : ''}
          </Button>
          <Button size="small" disabled={!session.canRedo || disabled} onClick={() => session.redo()}>
            Redo
          </Button>
        </Box>
        <Typography variant="body2" color="text.secondary">
          {TOOL_HELP[tools.tool]}
          {tools.tool !== 'navigate' && !segment && ' Add a segment first.'}
        </Typography>
      </Section>

      {(tools.tool === 'brush' || tools.tool === 'eraser') && (
        <Section title={`Brush radius: ${tools.brushRadiusMm} mm`}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Slider
              size="small"
              min={0.5}
              max={50}
              step={0.5}
              value={tools.brushRadiusMm}
              onChange={(_, value) => setTools({ brushRadiusMm: value as number })}
              sx={{ flexGrow: 1 }}
            />
            <FormControlLabel
              control={<Switch size="small" checked={tools.sphere} onChange={(_, checked) => setTools({ sphere: checked })} />}
              label="3D ball"
            />
          </Box>
        </Section>
      )}

      <Section
        title={
          <FormControlLabel
            control={
              <Switch size="small" checked={tools.rangeEnabled} onChange={(_, checked) => setTools({ rangeEnabled: checked })} />
            }
            label={`Value range: ${formatValue(tools.range[0], units)} to ${formatValue(tools.range[1], units)}`}
          />
        }
      >
        {tools.rangeEnabled ? (
          <>
            <Slider
              size="small"
              min={minValue}
              max={maxValue}
              step={valueStep}
              disableSwap
              value={tools.range}
              onChange={(_, value) => setTools({ range: value as [number, number] })}
            />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <FormControlLabel
                control={
                  <Switch size="small" checked={tools.previewRange} onChange={(_, checked) => setTools({ previewRange: checked })} />
                }
                label="Show on views"
              />
              <Tooltip title="Add every voxel in the range to the active segment">
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={!segment || disabled}
                    onClick={() =>
                      runEdit('Threshold', (edit) => thresholdJob(volume, edit, { label, ...storedRange(), overwrite: tools.overwrite }))
                    }
                  >
                    Apply threshold
                  </Button>
                </span>
              </Tooltip>
            </Box>
          </>
        ) : (
          tools.tool === 'grow' && (
            <Box>
              <Typography variant="body2">
                Grow tolerance: ±{formatValue(tools.growTolerance, units)} around the clicked voxel
              </Typography>
              <Slider
                size="small"
                min={valueStep}
                max={Math.max(valueStep, (maxValue - minValue) / 4)}
                step={valueStep}
                value={tools.growTolerance}
                onChange={(_, value) => setTools({ growTolerance: value as number })}
              />
            </Box>
          )
        )}
        <Typography variant="body2" color="text.secondary">
          With a range, the brush and region growing only take voxels inside it.
        </Typography>
      </Section>

      <FormControlLabel
        control={<Switch size="small" checked={tools.overwrite} onChange={(_, checked) => setTools({ overwrite: checked })} />}
        label="Paint over other segments"
      />

      <Section title={`Active segment${segment ? `: ${segment.name}` : ''}`}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <TextField
            size="small"
            type="number"
            label="mm"
            value={morphologyMm}
            onChange={(e) => setMorphologyMm(Math.max(0.1, Number(e.target.value) || 0.1))}
            slotProps={{ htmlInput: { min: 0.1, step: 0.5 } }}
            sx={{ width: 80 }}
          />
          <Button
            size="small"
            disabled={!hasVoxels || disabled}
            onClick={() => runEdit('Grow', (edit) => dilateJob(volume, edit, { label, radiusMm: morphologyMm, overwrite: tools.overwrite }))}
          >
            Grow
          </Button>
          <Button
            size="small"
            disabled={!hasVoxels || disabled}
            onClick={() => runEdit('Shrink', (edit) => erodeJob(volume, edit, { label, radiusMm: morphologyMm, overwrite: tools.overwrite }))}
          >
            Shrink
          </Button>
          <Tooltip title="Fill enclosed cavities">
            <span>
              <Button
                size="small"
                disabled={!hasVoxels || disabled}
                onClick={() => runEdit('Fill holes', (edit) => fillHolesJob(edit, label, false, tools.overwrite))}
              >
                Fill holes
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="Fill holes in each acquired slice separately">
            <span>
              <Button
                size="small"
                disabled={!hasVoxels || disabled}
                onClick={() => runEdit('Fill holes per slice', (edit) => fillHolesJob(edit, label, true, tools.overwrite))}
              >
                Fill per slice
              </Button>
            </span>
          </Tooltip>
          <Button
            size="small"
            disabled={!hasVoxels || disabled}
            onClick={() => runEdit('Keep largest piece', (edit) => keepLargestComponentJob(edit, label))}
          >
            Keep largest
          </Button>
          <Tooltip title="Fill the acquired slices between the slices you painted, blending their shapes">
            <span>
              <Button
                size="small"
                disabled={!hasVoxels || disabled}
                onClick={() => runEdit('Interpolate', (edit) => interpolateSlicesJob(volume, edit, label, tools.overwrite))}
              >
                Interpolate slices
              </Button>
            </span>
          </Tooltip>
          <Button
            size="small"
            color="error"
            disabled={!hasVoxels || disabled}
            onClick={() => runEdit('Clear segment', (edit) => clearLabelJob(edit, label))}
          >
            Clear
          </Button>
        </Box>
      </Section>

      <Section title="Display">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <FormControlLabel
            control={
              <Switch size="small" checked={display.showOverlay} onChange={(_, checked) => setDisplay({ showOverlay: checked })} />
            }
            label="Overlay"
          />
          <FormControlLabel
            control={<Switch size="small" checked={display.outline} onChange={(_, checked) => setDisplay({ outline: checked })} />}
            label="Outline"
          />
          <Typography variant="body2">Fill</Typography>
          <Slider
            size="small"
            min={0}
            max={1}
            step={0.05}
            value={display.fillOpacity}
            onChange={(_, value) => setDisplay({ fillOpacity: value as number })}
            sx={{ width: 120 }}
          />
        </Box>
      </Section>
    </Box>
  );
}
