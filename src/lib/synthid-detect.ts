import { fft2d, phaseOf } from './fft';
import { boxFilter, resampleSeparable, rotate90Clockwise, rotate90Counterclockwise, rotate180 } from './pixels';
import type { Bitmap, SynthidDetection } from './types';
import { yieldToBrowser } from './util';
import { SYNTHID_CODEBOOK, type SynthidCodebook, type SynthidCodebookProfile } from './synthid-codebook';

// ---------------------------------------------------------------------------
// SynthID detection
//
// Browser port of the reverse-SynthID project's V4 codebook detector
// (https://github.com/aloshdenny/reverse-SynthID, MIT License). The watermark
// is an FFT phase pattern: the detector compares the image's FFT phase at
// known high-consensus carrier bins against the codebook reference phases and
// scores the agreement. This is a statistical heuristic tuned for Gemini
// model generations, not Google's proprietary decoder, so results are
// best-effort signals, not guarantees.
// ---------------------------------------------------------------------------

// Channel weights from the upstream detector: green carries the strongest
// watermark energy.
const CHANNEL_WEIGHTS = [0.25, 0.55, 0.2];
// Number of strongest-consensus bins scored per channel.
const TOP_K = 128;
const MIN_INDEPENDENT_CARRIERS_PER_CHANNEL = 8;
// Carrier bins whose FFT magnitude sits at the floating-point round-off floor
// carry no phase information; scoring them lets deterministic round-off
// residue masquerade as a phase match on flat or gradient content. Bins below
// this fraction of the plane's strongest magnitude are skipped.
const ENERGY_FLOOR = 1e-8;
// Sigmoid center/steepness from the upstream detector: a phase match near
// 0.52 separates watermarked from clean content.
const PHASE_MATCH_CENTER = 0.52;
const PHASE_MATCH_STEEPNESS = 18;
// Aspect-ratio tolerance for trusting a clean scaled (and possibly rotated)
// match. A resized delivery keeps the profile's aspect ratio to within
// rounding, while a size built for another aspect sits further away.
const CLEAN_MATCH_AR_TOLERANCE = 0.003;

// The verdict is the strongest of several profile, model, and orientation
// hypotheses. For clean content every hypothesis is noise-level, and keeping
// the maximum raises the expected score above the noise mean by roughly
// sqrt(2 ln K) standard errors, so a fixed decision center flags clean images
// more often as the hypothesis count grows. Each candidate's phase match
// carries its own standard error, estimated from the spread of its per-bin
// scores, and the center is raised by that expected best-of-K noise term: a
// consistent watermark barely moves the bar, while an inconsistent noise-level
// match must clear a bar proportional to its own spread.
function expectedMaxNoiseSigmas(hypotheses: number): number {
	return Math.sqrt(2 * Math.log(Math.max(1, hypotheses)));
}

interface CarrierBin {
	y: number;
	x: number;
	cons: number;
	phase: number;
}

interface DecodedProfile {
	model: string;
	h: number;
	w: number;
	channels: CarrierBin[][];
}

const profileCache = new Map<SynthidCodebookProfile, DecodedProfile>();

function decodeBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeProfile(profile: SynthidCodebookProfile): DecodedProfile {
	const cached = profileCache.get(profile);
	if (cached) return cached;
	const channels = profile.channels.map((packed) => {
		const bytes = decodeBase64(packed);
		const bins: CarrierBin[] = [];
		for (let offset = 0; offset + 7 <= bytes.length; offset += 7) {
			const y = bytes[offset] | (bytes[offset + 1] << 8);
			const x = bytes[offset + 2] | (bytes[offset + 3] << 8);
			// A bin outside the profile plane would index undefined FFT values
			// and poison the score with NaN; drop it rather than score it.
			if (y >= profile.h || x >= profile.w) continue;
			const cons = bytes[offset + 4] / 255;
			// Little-endian signed int16, stored in milliradians.
			const phaseMr = (bytes[offset + 5] | (bytes[offset + 6] << 8)) << 16 >> 16;
			bins.push({ y, x, cons, phase: phaseMr / 1000 });
		}
		// Packed data is pre-sorted by consensus; keep the contract explicit.
		bins.sort((a, b) => b.cons - a.cons);
		return bins;
	});
	// The scoring loop indexes the R, G and B planes by position, so pad a
	// shorter channel list: a missing plane simply carries no carriers.
	while (channels.length < 3) channels.push([]);
	const decoded: DecodedProfile = { model: profile.model, h: profile.h, w: profile.w, channels };
	profileCache.set(profile, decoded);
	return decoded;
}

function decodedProfiles(codebook: SynthidCodebook): DecodedProfile[] {
	return codebook.profiles.map(decodeProfile);
}

interface ProfileCandidate {
	profile: DecodedProfile;
	// Clockwise quarter-turns applied to the source before the carrier check:
	// 0 (upright), 1 (90 degrees), 2 (180 degrees), or 3 (270 degrees). A
	// transposed delivery can be either quarter turn away from the profile and
	// an upside-down delivery is a half turn away, so the orientations whose
	// dimensions fit the profile are all scored and the phase match decides
	// which is real.
	rotation: 0 | 1 | 2 | 3;
	// True when the input size equals the profile's native size in the
	// candidate's orientation, so the verdict reports an exact profile match.
	native: boolean;
	// Base trust for the candidate's phase score: native and clean profile
	// matches are trusted while the input still carries enough of the
	// profile's carriers, and the loose fallback is trusted when its verdict
	// survives the significance test. A clean match too small to carry the
	// carriers is the one case the detector cannot vouch for.
	conclusive: boolean;
}

// Scored result for one candidate hypothesis.
interface CandidateOutcome {
	confidence: number;
	phaseMatch: number;
	profile: DecodedProfile;
	native: boolean;
	conclusive: boolean;
}

// Whether the input can carry enough of the profile's carriers for the phase
// score to mean anything. A resize folds every carrier above the input's
// Nyquist away, so a size whose dimensions leave fewer than the detector's
// minimum independent carriers below that Nyquist scores interpolation noise:
// a tiny icon matches a profile by aspect ratio alone, and its noise-level
// verdict must not be certified as a trusted profile match. Carriers are
// compared at their stored bins, so the physical frequency is the folded
// coordinate min(bin, dimension - bin). The check mirrors the scorer's top-K
// independent set exactly: conjugate bins are one physical carrier and the
// scorer counts them once, so counting them here would certify a size the
// scorer cannot produce a verdict from.
function carriesEnoughCarriers(profile: DecodedProfile, sourceWidth: number, sourceHeight: number): boolean {
	for (const bins of profile.channels) {
		const usable = Math.min(TOP_K, bins.length);
		if (usable < MIN_INDEPENDENT_CARRIERS_PER_CHANNEL) continue;
		const seen = new Set<number>();
		let survived = 0;
		for (let i = 0; i < bins.length && seen.size < usable; i += 1) {
			const bin = bins[i];
			const idx = bin.y * profile.w + bin.x;
			const conjugateIdx = ((profile.h - bin.y) % profile.h) * profile.w + (profile.w - bin.x) % profile.w;
			if (idx === conjugateIdx) continue;
			const independentIdx = Math.min(idx, conjugateIdx);
			if (seen.has(independentIdx)) continue;
			seen.add(independentIdx);
			const fx = Math.min(bin.x, profile.w - bin.x);
			const fy = Math.min(bin.y, profile.h - bin.y);
			if (fx <= sourceWidth / 2 && fy <= sourceHeight / 2) survived += 1;
		}
		if (survived >= MIN_INDEPENDENT_CARRIERS_PER_CHANNEL) return true;
	}
	return false;
}

// Candidate profiles for an image size, in preference order. First the
// profiles the input size maps onto natively: the same orientation, plus the
// transposed orientation scored under both quarter turns and, for square
// sizes, every orientation, because a delivered rotation carries no record of
// which way it was turned and the exact branch must not hide it. Without a
// native match, sizes the image is a clean scaled version of are preferred:
// delivery paths can export at a higher resolution than the reference set
// captured, and those keep their carriers aligned once resampled back. Clean
// matches only earn a trusted verdict while the input still carries the
// profile's carriers (see carriesEnoughCarriers), so a size too small to hold
// the watermark is scored but reported as inconclusive. The loose
// closest-profile-per-model fallback covers all remaining sizes, rotating
// nothing, since a wrong rotation risks scoring misaligned carriers as
// evidence; its verdicts take the same significance test as every other
// candidate, so a flag there is actionable and a clean verdict is clean.
// Models sharing a resolution are all returned because only the input's
// carrier phases can reveal which model produced it.
function selectCandidateProfiles(
	profiles: DecodedProfile[],
	h: number,
	w: number
): ProfileCandidate[] {
	if (profiles.length === 0) {
		throw new Error('No SynthID codebook profiles are available for detection.');
	}
	const nativeCandidates: ProfileCandidate[] = [];
	for (const profile of profiles) {
		if (profile.h === h && profile.w === w) {
			nativeCandidates.push({ profile, rotation: 0, native: true, conclusive: true });
			// A half turn keeps the profile's dimensions in every case.
			nativeCandidates.push({ profile, rotation: 2, native: true, conclusive: true });
			// A quarter turn of a square image keeps its dimensions too, so
			// the exact-size branch must score the quarter turns as well;
			// otherwise a rotated square delivery reads as upright noise and
			// can be reported as a conclusive clean check.
			if (h === w) {
				nativeCandidates.push({ profile, rotation: 1, native: true, conclusive: true });
				nativeCandidates.push({ profile, rotation: 3, native: true, conclusive: true });
			}
		} else if (h !== w && profile.h === w && profile.w === h) {
			// A native-size transposed delivery. Both quarter turns restore an
			// upright orientation, so both are scored and the phases decide.
			nativeCandidates.push({ profile, rotation: 1, native: true, conclusive: true });
			nativeCandidates.push({ profile, rotation: 3, native: true, conclusive: true });
		}
	}
	if (nativeCandidates.length > 0) return nativeCandidates;

	const targetAr = h / (w + 1e-9);
	const clean: ProfileCandidate[] = [];
	const seenSizes = new Set<string>();
	for (const candidate of profiles) {
		const key = `${candidate.h}x${candidate.w}`;
		if (seenSizes.has(key)) continue;
		seenSizes.add(key);
		const uprightAr = candidate.h / (candidate.w + 1e-9);
		const rotatedAr = candidate.w / (candidate.h + 1e-9);
		const uprightDiff = Math.abs(uprightAr - targetAr) / (targetAr + 1e-9);
		const rotatedDiff = Math.abs(rotatedAr - targetAr) / (targetAr + 1e-9);
		const upright = uprightDiff <= CLEAN_MATCH_AR_TOLERANCE;
		// Square sizes need no separate dimension check: a square candidate
		// has equal upright and rotated aspects, and a square input has
		// target aspect 1, so only genuinely matching sizes pass either way.
		const rotated = rotatedDiff <= CLEAN_MATCH_AR_TOLERANCE;
		if (!upright && !rotated) continue;
		for (const match of profiles) {
			if (match.h !== candidate.h || match.w !== candidate.w) continue;
			if (upright) {
				// An upright clean match can also be delivered upside down,
				// which keeps its dimensions.
				const conclusive = carriesEnoughCarriers(match, w, h);
				clean.push({ profile: match, rotation: 0, native: false, conclusive });
				clean.push({ profile: match, rotation: 2, native: false, conclusive });
			}
			if (rotated) {
				const conclusive = carriesEnoughCarriers(match, h, w);
				clean.push({ profile: match, rotation: 1, native: false, conclusive });
				clean.push({ profile: match, rotation: 3, native: false, conclusive });
			}
		}
	}
	if (clean.length > 0) return clean;

	const bestPerModel = new Map<string, { profile: DecodedProfile; score: number }>();
	for (const candidate of profiles) {
		const arDiff = Math.abs(candidate.h / (candidate.w + 1e-9) - targetAr) / (targetAr + 1e-9);
		const pxDiff = Math.abs(candidate.h * candidate.w - h * w) / (h * w + 1e-9);
		const score = arDiff * 2 + pxDiff;
		const current = bestPerModel.get(candidate.model);
		if (!current || score < current.score) {
			bestPerModel.set(candidate.model, { profile: candidate, score });
		}
	}
	return [...bestPerModel.values()].map((entry) => ({ profile: entry.profile, rotation: 0, native: false, conclusive: true }));
}

// Outcome of scoring one candidate's carriers against a transformed plane.
// The per-bin match scores are summarized as a mean plus the sample variance
// the caller needs to estimate the standard error of that mean.
interface ChannelMatch {
	mean: number;
	count: number;
	variance: number;
}

function channelScore(
	re: Float64Array,
	im: Float64Array,
	size: number,
	width: number,
	bins: CarrierBin[]
): ChannelMatch | null {
	const usable = Math.min(TOP_K, bins.length);
	if (usable === 0) return null;
	// Reference energy: strongest magnitude on the plane (typically DC). Only
	// bins with genuine energy above the round-off floor contribute. The scan
	// is bounded to the plane in use; the shared buffers may be larger.
	let maxMag2 = 0;
	for (let i = 0; i < size; i += 1) {
		const mag2 = re[i] * re[i] + im[i] * im[i];
		if (mag2 > maxMag2) maxMag2 = mag2;
	}
	if (maxMag2 === 0) return null;
	const floor2 = ENERGY_FLOOR * ENERGY_FLOOR * maxMag2;
	let total = 0;
	let totalSquares = 0;
	let counted = 0;
	const height = size / width;
	const seen = new Set<number>();
	for (let i = 0; i < bins.length && seen.size < usable; i += 1) {
		const bin = bins[i];
		const idx = bin.y * width + bin.x;
		const conjugateIdx = ((height - bin.y) % height) * width + (width - bin.x) % width;
		if (idx === conjugateIdx) continue;
		const independentIdx = Math.min(idx, conjugateIdx);
		if (seen.has(independentIdx)) continue;
		seen.add(independentIdx);
		const mag2 = re[idx] * re[idx] + im[idx] * im[idx];
		if (mag2 < floor2) continue;
		const diff = phaseOf(re[idx], im[idx]) - bin.phase;
		// Wrap to (-pi, pi] then map to a 0..1 match score.
		const wrapped = Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff)));
		const score = 1 - wrapped / Math.PI;
		total += score;
		totalSquares += score * score;
		counted += 1;
	}
	if (counted < MIN_INDEPENDENT_CARRIERS_PER_CHANNEL) return null;
	const mean = total / counted;
	// Sample variance; counted clears the eight-carrier minimum, so the
	// denominator is never zero. Clamp away the tiny negative rounding
	// residue of the sum-of-squares form.
	const variance = Math.max(0, (totalSquares - counted * mean * mean) / (counted - 1));
	return { mean, count: counted, variance };
}

// Runs the carrier-phase check on an RGBA bitmap. Non-exact image sizes are
// area-resampled to a candidate profile's native resolution first, mirroring
// the upstream detector's approach of avoiding resample ringing by working at
// profile dimensions. A native transposed or rotated delivery and a clean
// scaled and/or rotated version of a profile are matched strictly, scoring
// every orientation whose dimensions fit the profile so the unknown delivered
// rotation cannot hide a watermark; other sizes fall back to the closest
// profile per model. When a resolution matches profiles from more than one
// model, each is scored and the strongest watermark signal wins, so an image
// is checked against its own model's carriers rather than always the first.
// Callers that pre-resampled the bitmap (e.g. to a detection size cap) set
// preResampled so exactMatch reports that the input itself was not native.
// The confidence of every candidate is significance-adjusted for the number
// of scored hypotheses (see expectedMaxNoiseSigmas), so taking the strongest
// of several profile, model, and orientation candidates cannot turn clean
// content into a detection. The fallback branch takes the same adjustment
// even though it scores one orientation per model, because a fallback verdict
// cannot be told apart from clean content without it. A caller whose file
// metadata names the SynthID watermark sets sensitive to skip the adjustment:
// that prior makes the marginal score meaningful, while without it the
// adjustment is what keeps clean content from flagging. The returned
// conclusive flag reports whether the winning verdict is trusted: native
// matches, clean matches whose input carries the profile's carriers, and
// fallback verdicts are conclusive, while a clean match too small to carry
// the carriers is not, and callers must surface it as inconclusive.
export async function detectSynthid(
	bitmap: Bitmap,
	options: { codebook?: SynthidCodebook; preResampled?: boolean; sensitive?: boolean } = {}
): Promise<SynthidDetection> {
	const codebook = options.codebook ?? SYNTHID_CODEBOOK;
	const profiles = decodedProfiles(codebook);
	const candidates = selectCandidateProfiles(profiles, bitmap.height, bitmap.width);

	let best: CandidateOutcome | null = null;
	// A trusted profile match is preferred over an inconclusive one: the
	// inconclusive hypotheses are exactly the ones whose source cannot carry
	// the profile's carriers, so their scores are noise and must not displace
	// a candidate the detector can actually vouch for.
	let bestConclusive: CandidateOutcome | null = null;
	// One FFT plane pair is allocated at the largest candidate size and reused
	// across channels and candidates instead of reallocating per pass. This
	// relies on an unwritten convention, not anything the code enforces: each
	// channel pass must fully overwrite re[0..size) and im[0..size) before
	// reading, and channelScore must only read within [0, size), so stale
	// entries beyond size are never observed. A future pass that reads without
	// a full overwrite would silently consume stale data; keep that in mind
	// when editing the loop below.
	const planeSize = Math.max(...candidates.map((c) => c.profile.h * c.profile.w));
	const re = new Float64Array(planeSize);
	const im = new Float64Array(planeSize);
	// Candidates that share a rotation and profile dimensions share one
	// transformed plane per channel, because the FFT depends only on the
	// pixels. Models sharing a resolution therefore cost one transform
	// instead of one per model, which keeps the extra orientation
	// hypotheses affordable.
	const groups = new Map<string, ProfileCandidate[]>();
	for (const candidate of candidates) {
		const key = `${candidate.rotation}:${candidate.profile.w}x${candidate.profile.h}`;
		const group = groups.get(key);
		if (group) group.push(candidate);
		else groups.set(key, [candidate]);
	}
	// Every hypothesis is scored and the strongest phase match wins. The
	// phase score, not the image dimensions, is what tells the true
	// orientation and model apart: the codebook holds both orientations of
	// each aspect, so a rotated delivery often leaves a marginal upright
	// match from another profile, and stopping at the first flagged upright
	// candidate would attribute the watermark to the wrong profile. A trusted
	// profile match outranks an inconclusive one even when the latter scores
	// higher, because an inconclusive candidate is exactly the one the
	// detector cannot produce a reliable verdict from.
	// Every scored hypothesis counts toward the noise correction, including
	// the fallback's single-orientation-per-model set: without it, a fallback
	// phase score just above the raw center is indistinguishable from clean
	// content and would flag clean images. A corroborated caller skips it
	// because its metadata prior already establishes the watermark's presence.
	const maxNoiseSigmas = options.sensitive ? 0 : expectedMaxNoiseSigmas(candidates.length);
	for (const group of groups.values()) {
		// Rotation and native do not vary within a group: they depend only on
		// the rotation, the profile dimensions, and the input dimensions.
		// Conclusive is read per entry because models sharing a resolution can
		// have different carrier counts.
		const { rotation, native } = group[0];
		const { w: profileWidth, h: profileHeight } = group[0].profile;
		let pixels: Uint8ClampedArray;
		if (rotation === 0 && native) {
			pixels = bitmap.data;
		} else {
			// Rotation and profile size are constant within a group, so every
			// model in the group shares this rotated, resampled source through
			// the group loop itself; no separate cache is needed.
			const source = rotation === 0
				? bitmap
				: rotation === 1
					? rotate90Clockwise(bitmap)
					: rotation === 2 ? rotate180(bitmap) : rotate90Counterclockwise(bitmap);
			// A native candidate already has the profile's dimensions
			// after the rotation, so only scaled candidates go through
			// the resampler.
			pixels = native
				? source.data
				: resampleSeparable(
					source.data,
					source.width,
					source.height,
					profileWidth,
					profileHeight,
					boxFilter
				);
		}

		const size = profileHeight * profileWidth;
		const accum = group.map(() => ({ weighted: 0, weightSum: 0, weightedVariance: 0 }));
		for (let channel = 0; channel < 3; channel += 1) {
			if (!group.some((entry) => entry.profile.channels[channel].length > 0)) continue;
			for (let p = 0; p < size; p += 1) {
				// Fully transparent pixels are invisible, so their stored RGB
				// must not drive the verdict; neutralize them to zero.
				re[p] = pixels[p * 4 + 3] === 0 ? 0 : pixels[p * 4 + channel];
				im[p] = 0;
			}
			await yieldToBrowser();
			fft2d(re, im, profileWidth, profileHeight);
			for (let g = 0; g < group.length; g += 1) {
				const bins = group[g].profile.channels[channel];
				if (bins.length === 0) continue;
				const match = channelScore(re, im, size, profileWidth, bins);
				if (match === null) continue;
				const weight = CHANNEL_WEIGHTS[channel];
				accum[g].weighted += match.mean * weight;
				accum[g].weightSum += weight;
				// Pooled variance of the weighted channel mean: each channel
				// contributes (w / W)^2 * variance / count.
				accum[g].weightedVariance += weight * weight * (match.variance / match.count);
			}
		}

		for (let g = 0; g < group.length; g += 1) {
			const { weighted, weightSum, weightedVariance } = accum[g];
			const phaseMatch = weightSum > 0 ? weighted / weightSum : 0;
			// Standard error of the weighted channel mean. A watermark whose
			// carriers all agree has near-zero spread and keeps the calibrated
			// center; a noise-level match is spread out and must clear the
			// expected best-of-K inflation of its own score.
			const standardError = weightSum > 0 ? Math.sqrt(weightedVariance) / weightSum : 0;
			const confidence = 1 / (1 + Math.exp(-PHASE_MATCH_STEEPNESS * (phaseMatch - PHASE_MATCH_CENTER - maxNoiseSigmas * standardError)));
			const { profile, conclusive } = group[g];
			const outcome: CandidateOutcome = { confidence, phaseMatch, profile, native, conclusive };
			if (!best || confidence > best.confidence) best = outcome;
			if (conclusive && (!bestConclusive || confidence > bestConclusive.confidence)) bestConclusive = outcome;
		}
	}

	// selectCandidateProfiles throws on an empty codebook and every candidate
	// assigns best, so it is always set here.
	if (best === null) {
		throw new Error('SynthID detection found no candidate profiles to evaluate.');
	}
	const winner = bestConclusive ?? best;

	return {
		isWatermarked: winner.confidence > 0.5,
		confidence: Math.min(1, winner.confidence),
		phaseMatch: winner.phaseMatch,
		profileKey: `${winner.profile.model}/${winner.profile.h}x${winner.profile.w}`,
		exactMatch: winner.native && !options.preResampled,
		conclusive: winner.conclusive,
	};
}
