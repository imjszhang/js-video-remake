import path from 'node:path';
import { appError } from '../errors.js';

const SPEC_SCHEMA = 'video-remake.reproduction@2';
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(where, message) {
    throw appError('REPRO_INVALID', `${where}: ${message}`);
}

function object(value, where, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        invalid(where, 'expected an object');
    }
    if (allowed) {
        for (const key of Object.keys(value)) {
            if (!allowed.includes(key)) invalid(`${where}.${key}`, 'unknown field');
        }
    }
    return value;
}

function string(value, where) {
    if (typeof value !== 'string' || !value.trim()) invalid(where, 'expected a nonempty string');
    return value.trim();
}

function identifier(value, where) {
    if (typeof value !== 'string' || !ID.test(value) || RESERVED.has(value)) {
        invalid(where, 'expected a safe identifier starting with a letter (up to 64 characters)');
    }
    return value;
}

function array(value, where, { min = 0, max = Infinity } = {}) {
    if (!Array.isArray(value) || value.length < min || value.length > max) {
        invalid(where, `expected an array with ${min} to ${Number.isFinite(max) ? max : 'any number of'} items`);
    }
    return value;
}

function unique(values, where) {
    if (new Set(values).size !== values.length) invalid(where, 'duplicate values are not allowed');
    return values;
}

function number(value, where, { integer = false, min = 0, exclusive = false, max = Infinity } = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))
        || (exclusive ? value <= min : value < min) || value > max) {
        invalid(where, `expected a finite ${integer ? 'integer' : 'number'} ${exclusive ? 'greater than' : 'at least'} ${min}${Number.isFinite(max) ? ` and at most ${max}` : ''}`);
    }
    return value;
}

// This format deliberately uses portable, workspace-relative paths. It never
// permits harness input to point at repository internals or credential files.
export function safeProjectPath(value, where = 'path') {
    if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f\x7f\\]/.test(value)
        || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
        invalid(where, 'expected a safe relative file path');
    }
    const parts = value.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..'
        || /^(?:\.git|node_modules|secrets?|credentials|\.ssh|\.aws)$/i.test(part)
        || (/^\.env/i.test(part) && part !== '.env.example'))) {
        invalid(where, 'traversal, empty segments and sensitive paths are forbidden');
    }
    return value;
}

function strings(value, where, options) {
    return array(value, where, options).map((entry, i) => string(entry, `${where}[${i}]`));
}

function paths(value, where, options) {
    return unique(array(value, where, options).map((entry, i) => safeProjectPath(entry, `${where}[${i}]`)), where);
}

export function validateSpec(raw) {
    const spec = object(raw, 'spec', ['schema', 'title', 'objective', 'preserve', 'replace', 'inputs', 'acceptance', 'maxAttempts']);
    if (![SPEC_SCHEMA, 'video-remake.reproduction@1'].includes(spec.schema)) invalid('spec.schema', `expected ${SPEC_SCHEMA}`);
    const inputDefs = object(spec.inputs, 'spec.inputs');
    const inputs = Object.fromEntries(Object.entries(inputDefs).map(([name, rawInput]) => {
        identifier(name, `spec.inputs.${name}`);
        const input = object(rawInput, `spec.inputs.${name}`, ['type', 'required']);
        if (!['text', 'file'].includes(input.type)) invalid(`spec.inputs.${name}.type`, 'expected text or file');
        if (input.required !== undefined && typeof input.required !== 'boolean') invalid(`spec.inputs.${name}.required`, 'expected a boolean');
        return [name, { type: input.type, required: input.required ?? true }];
    }));
    const acceptance = object(spec.acceptance, 'spec.acceptance', ['media', 'requiredFiles', 'review', 'evidence']);
    const media = object(acceptance.media, 'spec.acceptance.media', ['file', 'width', 'height', 'durationSec', 'toleranceSec', 'audio']);
    if (!['required', 'optional', 'forbidden'].includes(media.audio)) invalid('spec.acceptance.media.audio', 'expected required, optional or forbidden');
    const review = array(acceptance.review, 'spec.acceptance.review', { min: 1 }).map((rawCheck, i) => {
        const check = object(rawCheck, `spec.acceptance.review[${i}]`, ['id', 'description', 'modality']);
        if (check.modality !== undefined && !['visual','audio','mixed'].includes(check.modality)) invalid('review.modality', 'expected visual, audio or mixed');
        return { ...(check.modality ? { modality: check.modality } : {}), id: identifier(check.id, `spec.acceptance.review[${i}].id`), description: string(check.description, `spec.acceptance.review[${i}].description`) };
    });
    unique(review.map((check) => check.id), 'spec.acceptance.review');
    const evidence = object(acceptance.evidence || {}, 'spec.acceptance.evidence', ['timestampsSec', 'boundariesSec', 'audioClipSec']);
    for (const key of ['timestampsSec', 'boundariesSec']) if (evidence[key] !== undefined) array(evidence[key], key, {max: 40}).forEach(t => number(t, key, {max: media.durationSec}));
    if (evidence.audioClipSec !== undefined) number(evidence.audioClipSec, 'audioClipSec', {exclusive: true, max: 30});
    if (/^(?:inputs|task|reference)\//.test(media.file)) invalid('media.file', 'output cannot overwrite input or task');
    return {
        schema: SPEC_SCHEMA,
        title: string(spec.title, 'spec.title'),
        objective: string(spec.objective, 'spec.objective'),
        preserve: strings(spec.preserve, 'spec.preserve', { min: 1 }),
        replace: strings(spec.replace, 'spec.replace'),
        inputs,
        acceptance: {
            evidence,
            media: {
                file: safeProjectPath(media.file, 'spec.acceptance.media.file'),
                width: number(media.width, 'spec.acceptance.media.width', { integer: true, min: 1 }),
                height: number(media.height, 'spec.acceptance.media.height', { integer: true, min: 1 }),
                durationSec: number(media.durationSec, 'spec.acceptance.media.durationSec', { exclusive: true }),
                toleranceSec: number(media.toleranceSec ?? 0.5, 'spec.acceptance.media.toleranceSec'),
                audio: media.audio,
            },
            requiredFiles: paths(acceptance.requiredFiles ?? [], 'spec.acceptance.requiredFiles'),
            review,
        },
        maxAttempts: number(spec.maxAttempts ?? 2, 'spec.maxAttempts', { integer: true, min: 1, max: 5 }),
    };
}
