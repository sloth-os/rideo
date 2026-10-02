import type { Timeline } from '../schemas/timeline';
import type { InterchangeContext, InterchangeFormat } from './common';
import { toEdl } from './edl';
import { toFcpxml } from './fcpxml';
import { toOtio } from './otio';
import { toXmeml } from './xmeml';

export {
  type FramedClip,
  framedAudio,
  framedPicture,
  INTERCHANGE_FORMAT_IDS,
  INTERCHANGE_FORMATS,
  type InterchangeContext,
  type InterchangeFormat,
  interchangeFileName,
  lanes,
  normalizeMediaBase,
  RECORD_START_SEC,
  type ReviewNote,
  timecode,
} from './common';
export { toEdl } from './edl';
export { toFcpxml } from './fcpxml';
export { fromOtio, type OtioClipRef, type OtioImportResult, OtioTimelineSchema, toOtio } from './otio';
export { toXmeml } from './xmeml';

/** The cut in an NLE's format (docs/design/interchange.md). */
export function exportCut(format: InterchangeFormat, t: Timeline, ctx: InterchangeContext): string {
  switch (format) {
    case 'otio':
      return `${JSON.stringify(toOtio(t, ctx), null, 2)}\n`;
    case 'fcpxml':
      return toFcpxml(t, ctx);
    case 'xml':
      return toXmeml(t, ctx);
    case 'edl':
      return toEdl(t, ctx);
  }
}
