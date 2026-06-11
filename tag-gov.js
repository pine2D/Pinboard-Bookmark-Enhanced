// ============================================================
// Pinboard Bookmark Enhanced - Tag Governance Engine (Pure)
// ============================================================

// Returns 0 (equal), 1 (exactly one edit), or 2 (more than one edit; sentinel).
// Specialized Levenshtein for distance <= 1 detection only (no full DP).
// Callers must pass normalized (lowercased) strings.
function pbpTagGovLevenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return 2;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        if (++diff > 1) return 2;
      }
    }
    return diff === 0 ? 0 : 1;
  }
  // length differs by 1: check one-gap alignment (insertion/deletion)
  const s = la < lb ? a : b, l = la < lb ? b : a;
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
    } else if (!skipped) {
      skipped = true;
      j++;
    } else {
      return 2;
    }
  }
  return 1;
}

// Find groups of related tags (plural, separator, typo).
// Returns [{id, kind, members, suggestedCanonical}, ...]
// Dot-tags ("."-prefixed) excluded from EVERYTHING.
// Kind priority: plural > separator > typo. Tags consumed by higher-priority groups
// are excluded from lower-priority groups.
function pbpTagGovFindGroups(counts) {
  const groups = [];
  const used = new Set();

  // Pass 1: Plural detection via algorithmic suffix rules
  const pluralGroups = _findPluralGroups(counts, used);
  groups.push(...pluralGroups);

  // Pass 2: Separator detection via bucket-by-normalized-key
  const sepGroups = _findSeparatorGroups(counts, used);
  groups.push(...sepGroups);

  // Pass 3: Typo detection via pairwise distance (skip used tags)
  const typoGroups = _findTypoGroups(counts, used);
  groups.push(...typoGroups);

  return groups;
}

function _findPluralGroups(counts, used) {
  const groups = [];
  const tags = Object.keys(counts).filter(t => !t.startsWith("."));
  const processed = new Set();

  const lcIndex = new Map();
  for (const t of Object.keys(counts)) {
    if (!t.startsWith(".")) lcIndex.set(t.toLowerCase(), t);
  }

  for (const tag of tags) {
    if (used.has(tag) || processed.has(tag)) continue;
    const lc = tag.toLowerCase();
    const candidates = _pluralizeCandidates(lc);

    for (const cand of candidates) {
      const candTag = lcIndex.get(cand);
      if (candTag && !used.has(candTag) && !processed.has(candTag)) {
        const members = [
          { tag, count: counts[tag] },
          { tag: candTag, count: counts[candTag] }
        ];
        const canonical = members[0].count >= members[1].count ? tag : candTag;
        const group = {
          id: [tag, candTag].sort().join("|"),
          kind: "plural",
          members,
          suggestedCanonical: canonical
        };
        groups.push(group);
        used.add(tag);
        used.add(candTag);
        processed.add(tag);
        processed.add(candTag);
        break;
      }
    }
  }

  return groups;
}

function _pluralizeCandidates(tag) {
  const cands = [];

  // Rule: tag + "s" (require base length >= 3: avoids le/les, a/as junk pairs)
  if (tag.length >= 3) cands.push(tag + "s");

  // Rule: tag + "es" when ends in s, x, z, ch, sh
  if (/[sxz]$/.test(tag) || /ch$/.test(tag) || /sh$/.test(tag)) {
    cands.push(tag + "es");
  }

  // Rule: consonant + "y" -> stem + "ies" (require consonant before y, stem len >= 2)
  if (/[^aeiou]y$/.test(tag) && tag.length >= 2) {
    const stem = tag.slice(0, -1);
    if (stem.length >= 1) cands.push(stem + "ies");
  }

  // Reverse: if tag ends in "ies", try singular form (consonant + y)
  if (/ies$/.test(tag) && tag.length >= 4) {
    const stem = tag.slice(0, -3);
    if (stem.length >= 2) {
      // Only valid if stem ends in consonant (not a vowel before y)
      const lastChar = stem[stem.length - 1];
      if (!/[aeiou]/.test(lastChar)) {
        cands.push(stem + "y");
      }
    }
  }

  // Reverse: if tag ends in "es", try without it (for s/x/z/ch/sh cases)
  if (/es$/.test(tag) && tag.length >= 3) {
    const stem = tag.slice(0, -2);
    if (/[sxz]$/.test(stem) || /ch$/.test(stem) || /sh$/.test(stem)) {
      cands.push(stem);
    }
  }

  // Reverse: if tag ends in "s" (not "es"), try without it (same >=3 base guard)
  if (/[^e]s$/.test(tag) && tag.length >= 4) {
    cands.push(tag.slice(0, -1));
  }

  return cands;
}

function _findSeparatorGroups(counts, used) {
  const groups = [];
  const buckets = new Map();
  const tags = Object.keys(counts).filter(t => !t.startsWith(".") && !used.has(t));

  for (const tag of tags) {
    const norm = tag.toLowerCase().replace(/[-_.]/g, "");
    if (!norm) continue;
    if (!buckets.has(norm)) buckets.set(norm, []);
    buckets.get(norm).push(tag);
  }

  for (const [, bucket] of buckets) {
    if (bucket.length >= 2) {
      const members = bucket.map(tag => ({ tag, count: counts[tag] }));
      members.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      const canonical = members[0].tag;
      const group = {
        id: [...bucket].sort().join("|"),
        kind: "separator",
        members,
        suggestedCanonical: canonical
      };
      groups.push(group);
      bucket.forEach(t => used.add(t));
    }
  }

  return groups;
}

function _findTypoGroups(counts, used) {
  const groups = [];
  const tags = Object.keys(counts).filter(t => !t.startsWith(".") && !used.has(t));

  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const tag1 = tags[i], tag2 = tags[j];
      if (used.has(tag1) || used.has(tag2)) continue;

      const lc1 = tag1.toLowerCase(), lc2 = tag2.toLowerCase();
      const dist = pbpTagGovLevenshtein(lc1, lc2);

      if (dist === 1 && lc1.length >= 5 && lc2.length >= 5) {
        const count1 = counts[tag1], count2 = counts[tag2];
        const minC = Math.min(count1, count2), maxC = Math.max(count1, count2);
        if (minC <= 2 && maxC >= 5 * minC) {
          const members = [
            { tag: tag1, count: count1 },
            { tag: tag2, count: count2 }
          ];
          members.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
          const canonical = members[0].tag;
          const group = {
            id: [tag1, tag2].sort().join("|"),
            kind: "typo",
            members,
            suggestedCanonical: canonical
          };
          groups.push(group);
          used.add(tag1);
          used.add(tag2);
        }
      }
    }
  }

  return groups;
}

// Build a rename plan: members -> canonical.
// Returns [{op: "rename", old, new}, ...] one per non-canonical member.
// Returns [] if canonical empty, not in members, dot-tag present, or case-insensitive match.
function pbpTagGovBuildPlan(members, canonical) {
  // members: [{ tag, count }] per contract
  if (!canonical || !Array.isArray(members) || members.length === 0) return [];
  const tags = members.map((m) => m && m.tag).filter((t) => typeof t === "string" && t);
  if (tags.length !== members.length) { console.debug("[tag-gov] BuildPlan: malformed members"); return []; }
  if (!tags.includes(canonical)) { console.debug("[tag-gov] BuildPlan: canonical not in members"); return []; }
  if (tags.some((t) => t.startsWith("."))) { console.debug("[tag-gov] BuildPlan: dot-tag present"); return []; }

  const plan = [];
  for (const tag of tags) {
    if (tag === canonical) continue;
    // Pinboard tags are case-insensitive server-side: a case-only "rename" is a
    // no-op there. Skip just this member — rejecting the WHOLE plan also dropped
    // legitimate sibling renames (e.g. {my-tag, my_tag, My-Tag} lost my_tag too)
    // and left a Merge button that silently did nothing.
    if (tag.toLowerCase() === canonical.toLowerCase()) {
      console.debug("[tag-gov] BuildPlan: skipping case-only member:", tag);
      continue;
    }
    plan.push({ op: "rename", old: tag, new: canonical });
  }
  return plan;
}

// Build AI prompt for merging groups.
// capN: max tags to include (default 1500).
// Returns string demanding strict JSON [{members, canonical, reason}] format.
function pbpTagGovBuildAiPrompt(counts, capN = 1500) {
  const tags = Object.keys(counts).filter(t => !t.startsWith("."));
  const sorted = tags.sort((a, b) => counts[b] - counts[a]);
  const included = sorted.slice(0, capN);
  const truncated = sorted.length > capN;

  const tagList = included.map((t) => JSON.stringify(t)).join(", ");
  const truncationNote = truncated ? `\n\nNote: This list includes the top ${capN} tags by frequency. ${sorted.length - capN} lower-frequency tags were omitted.` : "";

  return `You are a tag governance expert. Analyze the following list of bookmark tags and identify groups that should be merged:

${tagList}${truncationNote}

For each group you identify, return a JSON array with objects like:
[
  {"members": ["tag1", "tag2"], "canonical": "tag1", "reason": "brief explanation"},
  ...
]

STRICT REQUIREMENTS:
- Return ONLY valid JSON. No markdown, no explanation, no extra text.
- Every member tag MUST exist in the list above. Do NOT invent tags.
- Canonical must be one of the members.
- Reason should be brief: "plural", "separator variant", "typo", etc.
- If no merges are needed, return an empty array: []

JSON output:`;
}

// Parse AI response and extract groups.
// Strips markdown code fences. Returns [{id, kind: "ai", members, suggestedCanonical, reason}].
// Drops groups with: member not in counts, dot-tag member, <2 members, canonical not in members.
function pbpTagGovParseAiResponse(text, counts) {
  const groups = [];
  let json = text;

  // Strip markdown code fences
  json = json.replace(/^[`]{3}(?:json)?\s*\n?/, "").replace(/\n?[`]{3}\s*$/, "");
  json = json.trim();

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    console.debug("pbpTagGovParseAiResponse: JSON parse failed", e.message);
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  for (const item of parsed) {
    if (!Array.isArray(item.members) || item.members.length < 2 || !item.members.every((m) => typeof m === "string")) continue;
    if (item.members.some(m => m.startsWith("."))) continue;
    if (!item.canonical || item.members.indexOf(item.canonical) === -1) continue;
    if (!item.members.every(m => m in counts)) continue;

    const members = item.members.map(m => ({ tag: m, count: counts[m] }));
    const group = {
      id: item.members.sort().join("|"),
      kind: "ai",
      members,
      suggestedCanonical: item.canonical,
      reason: item.reason || ""
    };
    groups.push(group);
  }

  return groups;
}

// Return low-count tags: [{tag, count}, ...]
// count <= threshold (default 1); dot-tags excluded; sorted by tag asc.
function pbpTagGovLowCountTags(counts, threshold = 1) {
  const low = [];
  for (const [tag, count] of Object.entries(counts)) {
    if (tag.startsWith(".")) continue;
    if (count <= threshold) low.push({ tag, count });
  }
  low.sort((a, b) => a.tag.localeCompare(b.tag));
  return low;
}
