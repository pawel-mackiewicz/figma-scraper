#!/usr/bin/env node

/**
 * Export a Figma/FigJam board to one compact JSON file for an LLM.
 *
 * Usage:
 *   node figma-to-llm.mjs "FIGMA_URL" "FIGMA_ACCESS_TOKEN"
 *
 * Safer token usage:
 *   FIGMA_TOKEN="figd_..." node figma-to-llm.mjs "FIGMA_URL"
 *
 * Requirements:
 *   Node.js 20+
 */

import { writeFile } from 'node:fs/promises';

const API_BASE = 'https://api.figma.com/v1';
const MAX_RETRIES = 5;

const OMITTED_KEYS = new Set([
  'absoluteRenderBounds',
  'arcData',
  'interactions',
  'transitionNodeID',
  'transitionDuration',
  'transitionEasing',
  'prototypeStartNodeID',
  'flowStartingPoints',
  'pluginData',
  'sharedPluginData',
]);

function usage() {
  console.error(`
Usage:
  node figma-to-llm.mjs "FIGMA_URL" "FIGMA_ACCESS_TOKEN"

Or keep the token out of shell history:
  FIGMA_TOKEN="figd_..." node figma-to-llm.mjs "FIGMA_URL"
`);
}

function parseFigmaUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error('The first argument must be a valid Figma URL.');
  }

  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    throw new Error('The URL must point to figma.com.');
  }

  const segments = url.pathname.split('/').filter(Boolean);

  const supportedTypes = new Set([
    'design',
    'file',
    'proto',
    'board',
    'slides',
    'make',
  ]);

  const typeIndex = segments.findIndex((segment) =>
    supportedTypes.has(segment.toLowerCase()),
  );

  if (typeIndex === -1 || !segments[typeIndex + 1]) {
    throw new Error('Could not extract the file key from the Figma URL.');
  }

  const rawNodeId = url.searchParams.get('node-id');

  return {
    originalUrl: input,
    fileType: segments[typeIndex].toLowerCase(),
    fileKey: segments[typeIndex + 1],
    nodeId: rawNodeId ? normalizeNodeId(rawNodeId) : null,
  };
}

function normalizeNodeId(value) {
  const decoded = decodeURIComponent(String(value)).trim();

  if (decoded.includes(':')) {
    return decoded;
  }

  return decoded.replace(/-/g, ':');
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function figmaGet(path, token, { optional = false } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        'X-Figma-Token': token,
        Accept: 'application/json',
      },
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));

      const delaySeconds = Number.isFinite(retryAfter)
        ? retryAfter
        : Math.min(2 ** attempt, 30);

      console.warn(`Figma rate limit reached. Retrying in ${delaySeconds}s...`);

      await sleep(delaySeconds * 1000);
      continue;
    }

    const text = await response.text();
    let body = {};

    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {
          message: text,
        };
      }
    }

    if (response.ok) {
      return body;
    }

    const message =
      body.err ||
      body.message ||
      `Figma API request failed with HTTP ${response.status}`;

    lastError = new Error(message);

    if (response.status === 403) {
      lastError = new Error(
        'Figma rejected the token or the token cannot access ' +
          'this file. Check the token, its file_content:read ' +
          'scope, and the file permissions.',
      );
    } else if (response.status === 404) {
      lastError = new Error(
        'Figma could not find the file. Check the URL and ' +
          'confirm that the token owner can open it.',
      );
    }

    break;
  }

  if (optional) {
    console.warn(`Optional Figma request skipped: ${lastError?.message}`);

    return null;
  }

  throw lastError || new Error('Figma API retries were exhausted.');
}

function roundNumber(value) {
  if (!Number.isFinite(value)) {
    return value;
  }

  return Math.round(value * 1000) / 1000;
}

function compactValue(value, key = '', imageUrls = {}) {
  if (value === null || value === undefined || OMITTED_KEYS.has(key)) {
    return undefined;
  }

  if (typeof value === 'number') {
    return roundNumber(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    const items = value
      .map((item) => compactValue(item, '', imageUrls))
      .filter((item) => item !== undefined);

    return items.length ? items : undefined;
  }

  const result = {};

  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === 'children') {
      continue;
    }

    const compacted = compactValue(childValue, childKey, imageUrls);

    if (compacted !== undefined && compacted !== '') {
      result[childKey] = compacted;
    }
  }

  if (
    result.type === 'IMAGE' &&
    typeof result.imageRef === 'string' &&
    imageUrls[result.imageRef]
  ) {
    result.imageUrl = imageUrls[result.imageRef];
  }

  return Object.keys(result).length ? result : undefined;
}

function compactNode(node, parentPath, imageUrls) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const nodeName = node.name || node.type || node.id || 'Unnamed';

  const path = parentPath ? `${parentPath}/${nodeName}` : nodeName;

  const compacted = compactValue(node, '', imageUrls) || {};

  compacted.path = path;

  if (Array.isArray(node.children) && node.children.length) {
    compacted.children = node.children
      .map((child) => compactNode(child, path, imageUrls))
      .filter(Boolean);
  }

  return compacted;
}

function rgbaToHex(color, opacity = 1) {
  if (!color || typeof color !== 'object') {
    return null;
  }

  const channel = (number) =>
    Math.max(0, Math.min(255, Math.round((number ?? 0) * 255)))
      .toString(16)
      .padStart(2, '0');

  const alpha = (color.a ?? 1) * opacity;

  const rgb =
    `#${channel(color.r)}` + `${channel(color.g)}` + `${channel(color.b)}`;

  return alpha < 0.999 ? `${rgb}${channel(alpha)}` : rgb;
}

function extractDesignTokens(document) {
  const colors = new Set();
  const spacing = new Set();
  const radii = new Set();
  const typography = new Map();

  const spacingKeys = [
    'itemSpacing',
    'counterAxisSpacing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
  ];

  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    for (const paintListName of ['fills', 'strokes', 'background']) {
      const paints = node[paintListName];

      if (!Array.isArray(paints)) {
        continue;
      }

      for (const paint of paints) {
        if (paint?.type === 'SOLID' && paint.visible !== false) {
          const hex = rgbaToHex(paint.color, paint.opacity ?? 1);

          if (hex) {
            colors.add(hex);
          }
        }
      }
    }

    for (const key of spacingKeys) {
      if (typeof node[key] === 'number') {
        spacing.add(roundNumber(node[key]));
      }
    }

    if (typeof node.cornerRadius === 'number') {
      radii.add(roundNumber(node.cornerRadius));
    }

    if (Array.isArray(node.rectangleCornerRadii)) {
      for (const radius of node.rectangleCornerRadii) {
        if (typeof radius === 'number') {
          radii.add(roundNumber(radius));
        }
      }
    }

    if (node.type === 'TEXT' && node.style) {
      const style = node.style;

      const token = {
        fontFamily: style.fontFamily,
        fontPostScriptName: style.fontPostScriptName,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        lineHeightPx: style.lineHeightPx,
        lineHeightPercent: style.lineHeightPercent,
        letterSpacing: style.letterSpacing,
        textCase: style.textCase,
        textDecoration: style.textDecoration,
      };

      const cleaned = Object.fromEntries(
        Object.entries(token).filter(([, value]) => value !== undefined),
      );

      typography.set(JSON.stringify(cleaned), cleaned);
    }

    if (Array.isArray(node.children)) {
      node.children.forEach(visit);
    }
  };

  visit(document);

  return {
    colors: [...colors].sort(),

    spacing: [...spacing].sort((a, b) => a - b),

    radii: [...radii].sort((a, b) => a - b),

    typography: [...typography.values()],
  };
}

function countNodes(node) {
  if (!node || typeof node !== 'object') {
    return 0;
  }

  const childCount = Array.isArray(node.children)
    ? node.children.reduce((sum, child) => sum + countNodes(child), 0)
    : 0;

  return 1 + childCount;
}

function sanitizeFilename(value) {
  const sanitized = String(value || 'figma-export')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return sanitized || 'figma-export';
}

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('This script requires Node.js 20 or newer.');
  }

  const figmaUrl = process.argv[2];

  const token = process.argv[3] || process.env.FIGMA_TOKEN;

  if (!figmaUrl || !token) {
    usage();
    process.exitCode = 1;
    return;
  }

  const parsed = parseFigmaUrl(figmaUrl);

  const fileParams = new URLSearchParams();

  fileParams.set('geometry', 'paths');

  if (parsed.nodeId) {
    fileParams.set('ids', parsed.nodeId);
  }

  const filePath =
    `/files/${encodeURIComponent(parsed.fileKey)}` +
    `${fileParams.size ? `?${fileParams.toString()}` : ''}`;

  console.log(
    parsed.nodeId
      ? `Reading selected Figma node ${parsed.nodeId}...`
      : 'Reading the complete Figma file...',
  );

  const fileData = await figmaGet(filePath, token);

  const imageFillsPath = `/files/${encodeURIComponent(parsed.fileKey)}/images`;

  const previewPath = parsed.nodeId
    ? `/images/${encodeURIComponent(parsed.fileKey)}?${new URLSearchParams({
        ids: parsed.nodeId,
        format: 'png',
        scale: '2',
      }).toString()}`
    : null;

  const [imageFillData, previewData] = await Promise.all([
    figmaGet(imageFillsPath, token, {
      optional: true,
    }),

    previewPath
      ? figmaGet(previewPath, token, {
          optional: true,
        })
      : Promise.resolve(null),
  ]);

  const imageUrls = imageFillData?.images || {};

  const compactDocument = compactNode(fileData.document, '', imageUrls);

  const nodeCount = countNodes(compactDocument);

  const tokens = extractDesignTokens(compactDocument);

  const output = {
    schema: 'figma-llm-export@2',

    generatedAt: new Date().toISOString(),

    source: {
      figmaUrl: parsed.originalUrl,

      fileType: parsed.fileType,

      fileKey: parsed.fileKey,

      selectedNodeId: parsed.nodeId,

      fileName: fileData.name,

      lastModified: fileData.lastModified,

      version: fileData.version,

      editorType: fileData.editorType,

      thumbnailUrl: fileData.thumbnailUrl,
    },

    summary: {
      nodeCount,

      componentCount: Object.keys(fileData.components || {}).length,

      componentSetCount: Object.keys(fileData.componentSets || {}).length,

      styleCount: Object.keys(fileData.styles || {}).length,

      imageFillCount: Object.keys(imageUrls).length,
    },

    implementationGuidance: [
      'Use the Figma node hierarchy as the initial component hierarchy.',

      'Translate layoutMode HORIZONTAL or VERTICAL to flexbox before using absolute positioning.',

      'Use layoutSizingHorizontal, layoutSizingVertical, constraints, and layoutGrow for responsive behavior.',

      'Resolve INSTANCE nodes through componentId and the components map.',

      'Reuse repeated components instead of generating duplicate markup.',

      'Preserve typography, spacing, fills, strokes, effects, radii, opacity, and visibility.',

      'Use fillGeometry, strokeGeometry, and vectorNetwork data for exact custom vector paths.',

      'Use absoluteBoundingBox for measurements and fallback positioning, not as the default layout system.',
    ],

    preview: parsed.nodeId
      ? {
          nodeId: parsed.nodeId,

          pngUrl: previewData?.images?.[parsed.nodeId] || null,

          note: 'Figma render URLs are temporary.',
        }
      : null,

    designTokens: tokens,

    components: compactValue(fileData.components || {}, '', imageUrls) || {},

    componentSets:
      compactValue(fileData.componentSets || {}, '', imageUrls) || {},

    styles: compactValue(fileData.styles || {}, '', imageUrls) || {},

    assets: {
      imageFillsByRef: imageUrls,

      note: 'Figma image-fill URLs are temporary; download them if permanent assets are required.',
    },

    document: compactDocument,
  };

  const filename = `${sanitizeFilename(fileData.name)}-llm.json`;

  await writeFile(filename, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`Done: ${filename}`);

  console.log(`Nodes: ${nodeCount}`);

  console.log(`Image fills: ${Object.keys(imageUrls).length}`);

  if (!parsed.nodeId) {
    console.log(
      'Tip: use a Figma URL containing node-id to export only one frame or section.',
    );
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);

  process.exitCode = 1;
});
