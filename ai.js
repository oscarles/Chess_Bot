// ============================================================
//  ai.js  —  Optimized Chess AI
//  Techniques: Zobrist + Transposition Table, Iterative
//  Deepening (time-based), Null Move Pruning (with
//  allowNullMove flag), Killer Moves, History Heuristic,
//  Late Move Reduction, Quiescence
// ============================================================

// -------------------------------------------------------
//  Zobrist hashing
// -------------------------------------------------------
const _zrng = (() => {
  let s = 0x9e3779b9 | 0;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s >>> 0;
  };
})();

const ZB_PIECES = Array.from({ length: 13 }, () =>
  Array.from({ length: 64 }, _zrng),
);
const ZB_SIDE = _zrng();
const ZB_CASTLE = Array.from({ length: 16 }, _zrng);
const ZB_EP = Array.from({ length: 8 }, _zrng);

function computeZobrist(game) {
  let h = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = game.board[r][c];
      if (p) h ^= ZB_PIECES[p][r * 8 + c];
    }
  if (game.turn === BLACK) h ^= ZB_SIDE;
  const cr =
    (game.castlingRights.wK ? 1 : 0) |
    (game.castlingRights.wQ ? 2 : 0) |
    (game.castlingRights.bK ? 4 : 0) |
    (game.castlingRights.bQ ? 8 : 0);
  h ^= ZB_CASTLE[cr];
  if (game.enPassantSquare) h ^= ZB_EP[game.enPassantSquare[1]];
  return h >>> 0;
}

// -------------------------------------------------------
//  Transposition Table
// -------------------------------------------------------
const TT_SIZE = 1 << 20;
const TT_MASK = TT_SIZE - 1;
const TT_EXACT = 0,
  TT_LOWER = 1,
  TT_UPPER = 2;

class TranspositionTable {
  constructor() {
    this.slots = new Array(TT_SIZE).fill(null);
  }

  probe(hash) {
    const e = this.slots[hash & TT_MASK];
    return e && e.hash === hash ? e : null;
  }

  store(hash, depth, score, flag, move) {
    const idx = hash & TT_MASK;
    const e = this.slots[idx];
    if (!e || e.depth <= depth || e.hash !== hash) {
      this.slots[idx] = { hash, depth, score, flag, move };
    }
  }

  clear() {
    this.slots.fill(null);
  }
}

// -------------------------------------------------------
//  Piece values — used only for move ordering (MVV-LVA).
//  Real material values live in chess.js (MATERIAL); these
//  include a king sentinel for ordering safety.
// -------------------------------------------------------
const PIECE_VALUES = {
  [PIECES.W_PAWN]: 100,
  [PIECES.B_PAWN]: 100,
  [PIECES.W_KNIGHT]: 320,
  [PIECES.B_KNIGHT]: 320,
  [PIECES.W_BISHOP]: 330,
  [PIECES.B_BISHOP]: 330,
  [PIECES.W_ROOK]: 500,
  [PIECES.B_ROOK]: 500,
  [PIECES.W_QUEEN]: 900,
  [PIECES.B_QUEEN]: 900,
  [PIECES.W_KING]: 20000,
  [PIECES.B_KING]: 20000,
};

// -------------------------------------------------------
//  Evaluation (positive = white advantage)
//
//  Tapered: blends a middlegame and an endgame score
//  according to the phase weight of remaining pieces.
//  Material + PSTs are tracked incrementally on `game`
//  (see chess.js _applyMoveNoHistory); pawn structure
//  and king safety are computed on demand from the board.
// -------------------------------------------------------

// -------------------------------------------------------
//  Movement offset tables (flat — better than array-of-arrays
//  for tight inner loops; iterate by 2 to read [dr, dc] pairs)
// -------------------------------------------------------
const KNIGHT_OFFSETS = [-2,-1, -2,1, -1,-2, -1,2, 1,-2, 1,2, 2,-1, 2,1];
const BISHOP_OFFSETS = [-1,-1, -1,1, 1,-1, 1,1];
const ROOK_OFFSETS   = [-1, 0,  1, 0, 0,-1, 0, 1];
const QUEEN_OFFSETS  = [-1,-1, -1,1, 1,-1, 1,1, -1,0, 1,0, 0,-1, 0,1];
const KING_OFFSETS   = [-1,-1, -1,0, -1,1, 0,-1, 0,1, 1,-1, 1,0, 1,1];

// Passed-pawn bonus by ranks advanced from the home rank (0..5).
// Index 0 = starting rank, 5 = one square from promotion.
const PASSED_MG = [ 5, 10, 15, 25,  50,  90];
const PASSED_EG = [10, 20, 35, 60, 100, 160];

// Static scratch buffers for evaluate(). The search is single-threaded
// per worker so these don't need to be re-entrant. Reset at the top of
// each evaluate() call. Avoiding per-call allocations matters because
// evaluate() runs millions of times per second.
const _W_PAWN_FILES = new Uint8Array(8);   // count of white pawns on each file (also row-array length)
const _B_PAWN_FILES = new Uint8Array(8);
const _W_PAWN_ROWS  = [
  new Int8Array(8), new Int8Array(8), new Int8Array(8), new Int8Array(8),
  new Int8Array(8), new Int8Array(8), new Int8Array(8), new Int8Array(8),
];
const _B_PAWN_ROWS  = [
  new Int8Array(8), new Int8Array(8), new Int8Array(8), new Int8Array(8),
  new Int8Array(8), new Int8Array(8), new Int8Array(8), new Int8Array(8),
];
const _W_PAWN_ATK = new Uint8Array(64);
const _B_PAWN_ATK = new Uint8Array(64);

// Returns a non-positive penalty for `color`'s king. Pawn shield gaps
// and open/semi-open files near the king both contribute.
function evaluateKingSafety(board, color) {
  const king = color === WHITE ? PIECES.W_KING : PIECES.B_KING;
  let kr = -1, kc = -1;
  for (let r = 0; r < 8 && kr < 0; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === king) { kr = r; kc = c; break; }
    }
  }
  if (kr < 0) return 0;

  let penalty = 0;
  const ownPawn   = color === WHITE ? PIECES.W_PAWN : PIECES.B_PAWN;
  const enemyPawn = color === WHITE ? PIECES.B_PAWN : PIECES.W_PAWN;
  const fwd       = color === WHITE ? -1 : 1;
  const homeRank  = color === WHITE ?  7 : 0;

  // Pawn shield — only meaningful when the king is on (or near) its home rank.
  if (Math.abs(kr - homeRank) <= 1) {
    for (let dc = -1; dc <= 1; dc++) {
      const nc = kc + dc;
      if (nc < 0 || nc > 7) continue;
      const r1 = kr + fwd;
      const r2 = kr + 2 * fwd;
      if (r1 >= 0 && r1 < 8 && board[r1][nc] === ownPawn) {
        // close shield — no penalty
      } else if (r2 >= 0 && r2 < 8 && board[r2][nc] === ownPawn) {
        penalty -= 12; // distant shield
      } else {
        penalty -= 25; // missing shield
      }
    }
  }

  // Open / semi-open files near the king
  for (let dc = -1; dc <= 1; dc++) {
    const nc = kc + dc;
    if (nc < 0 || nc > 7) continue;
    let hasOwn = false, hasEnemy = false;
    for (let r = 0; r < 8; r++) {
      const p = board[r][nc];
      if (p === ownPawn) hasOwn = true;
      else if (p === enemyPawn) hasEnemy = true;
    }
    if (!hasOwn && !hasEnemy) penalty -= 18;       // fully open
    else if (!hasOwn) penalty -= 10;                // semi-open (no friendly pawn)
  }

  return penalty;
}

function evaluate(game) {
  const board = game.board;
  const phase = game.phase > MAX_PHASE ? MAX_PHASE : game.phase;
  const egPhase = MAX_PHASE - phase;

  let mg = game.material + game.psqt_mg;
  let eg = game.material + game.psqt_eg;

  // ============================================================
  // Pass 1: gather pawn structure data, pawn attack maps,
  //         and bishop counts in a single board scan.
  //         Uses static buffers reset here to avoid per-call allocations.
  // ============================================================
  _W_PAWN_FILES.fill(0);
  _B_PAWN_FILES.fill(0);
  _W_PAWN_ATK.fill(0);
  _B_PAWN_ATK.fill(0);
  const wPawnFiles = _W_PAWN_FILES;
  const bPawnFiles = _B_PAWN_FILES;
  const wPawnRows  = _W_PAWN_ROWS;
  const bPawnRows  = _B_PAWN_ROWS;
  const wPawnAtk = _W_PAWN_ATK;
  const bPawnAtk = _B_PAWN_ATK;
  let wBishops = 0, bBishops = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (p === PIECES.W_PAWN) {
        wPawnRows[c][wPawnFiles[c]++] = r;
        if (r > 0) {
          if (c > 0) wPawnAtk[(r - 1) * 8 + c - 1] = 1;
          if (c < 7) wPawnAtk[(r - 1) * 8 + c + 1] = 1;
        }
      } else if (p === PIECES.B_PAWN) {
        bPawnRows[c][bPawnFiles[c]++] = r;
        if (r < 7) {
          if (c > 0) bPawnAtk[(r + 1) * 8 + c - 1] = 1;
          if (c < 7) bPawnAtk[(r + 1) * 8 + c + 1] = 1;
        }
      } else if (p === PIECES.W_BISHOP) wBishops++;
      else if (p === PIECES.B_BISHOP) bBishops++;
    }
  }

  // ============================================================
  // Pawn structure: doubled, isolated, passed
  // ============================================================
  for (let c = 0; c < 8; c++) {
    if (wPawnFiles[c] > 1) { mg -= (wPawnFiles[c] - 1) * 10; eg -= (wPawnFiles[c] - 1) * 20; }
    if (bPawnFiles[c] > 1) { mg += (bPawnFiles[c] - 1) * 10; eg += (bPawnFiles[c] - 1) * 20; }
    const wAdj = (c > 0 ? wPawnFiles[c - 1] : 0) + (c < 7 ? wPawnFiles[c + 1] : 0);
    if (wPawnFiles[c] > 0 && wAdj === 0) { mg -= wPawnFiles[c] * 12; eg -= wPawnFiles[c] * 18; }
    const bAdj = (c > 0 ? bPawnFiles[c - 1] : 0) + (c < 7 ? bPawnFiles[c + 1] : 0);
    if (bPawnFiles[c] > 0 && bAdj === 0) { mg += bPawnFiles[c] * 12; eg += bPawnFiles[c] * 18; }
  }
  for (let c = 0; c < 8; c++) {
    const wCnt = wPawnFiles[c];
    for (let i = 0; i < wCnt; i++) {
      const r = wPawnRows[c][i];
      let blocked = false;
      for (let dc = -1; dc <= 1 && !blocked; dc++) {
        const nc = c + dc;
        if (nc < 0 || nc > 7) continue;
        const erRows = bPawnRows[nc];
        const erCnt = bPawnFiles[nc];
        for (let k = 0; k < erCnt; k++) if (erRows[k] < r) { blocked = true; break; }
      }
      if (!blocked) {
        const adv = 6 - r;
        if (adv >= 0 && adv <= 5) { mg += PASSED_MG[adv]; eg += PASSED_EG[adv]; }
      }
    }
    const bCnt = bPawnFiles[c];
    for (let i = 0; i < bCnt; i++) {
      const r = bPawnRows[c][i];
      let blocked = false;
      for (let dc = -1; dc <= 1 && !blocked; dc++) {
        const nc = c + dc;
        if (nc < 0 || nc > 7) continue;
        const erRows = wPawnRows[nc];
        const erCnt = wPawnFiles[nc];
        for (let k = 0; k < erCnt; k++) if (erRows[k] > r) { blocked = true; break; }
      }
      if (!blocked) {
        const adv = r - 1;
        if (adv >= 0 && adv <= 5) { mg -= PASSED_MG[adv]; eg -= PASSED_EG[adv]; }
      }
    }
  }

  // ============================================================
  // Bishop pair
  // ============================================================
  if (wBishops >= 2) { mg += 30; eg += 50; }
  if (bBishops >= 2) { mg -= 30; eg -= 50; }

  // ============================================================
  // Pass 2: piece activity — safe mobility, rook open files,
  //         knight outposts. "Safe" squares = not attacked by
  //         enemy pawns.
  // ============================================================
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const isW = p >= 1 && p <= 6;
      const sign = isW ? 1 : -1;
      const enemyAtk = isW ? bPawnAtk : wPawnAtk;

      switch (p) {
        case PIECES.W_KNIGHT: case PIECES.B_KNIGHT: {
          let m = 0;
          for (let i = 0; i < 16; i += 2) {
            const tr = r + KNIGHT_OFFSETS[i], tc = c + KNIGHT_OFFSETS[i + 1];
            if (tr < 0 || tr > 7 || tc < 0 || tc > 7) continue;
            const t = board[tr][tc];
            if (t && ((t >= 1 && t <= 6) === isW)) continue;
            if (enemyAtk[tr * 8 + tc]) continue;
            m++;
          }
          mg += sign * m * 4;
          eg += sign * m * 4;

          // Outpost: defended by own pawn, not under enemy pawn attack now,
          // and no enemy pawn on adjacent files ahead that could challenge.
          const ownAtk = isW ? wPawnAtk : bPawnAtk;
          if (ownAtk[r * 8 + c] && !enemyAtk[r * 8 + c]) {
            let challengeable = false;
            for (let ddc = -1; ddc <= 1 && !challengeable; ddc += 2) {
              const nc = c + ddc;
              if (nc < 0 || nc > 7) continue;
              const erRows = isW ? bPawnRows[nc] : wPawnRows[nc];
              const erCnt  = isW ? bPawnFiles[nc] : wPawnFiles[nc];
              for (let k = 0; k < erCnt; k++) {
                if ((isW && erRows[k] < r) || (!isW && erRows[k] > r)) { challengeable = true; break; }
              }
            }
            if (!challengeable) { mg += sign * 20; eg += sign * 15; }
          }
          break;
        }
        case PIECES.W_BISHOP: case PIECES.B_BISHOP: {
          let m = 0;
          for (let i = 0; i < 8; i += 2) {
            const dr = BISHOP_OFFSETS[i], dc = BISHOP_OFFSETS[i + 1];
            let tr = r + dr, tc = c + dc;
            while (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
              const t = board[tr][tc];
              if (t && ((t >= 1 && t <= 6) === isW)) break;
              if (!enemyAtk[tr * 8 + tc]) m++;
              if (t) break;
              tr += dr; tc += dc;
            }
          }
          mg += sign * m * 5;
          eg += sign * m * 5;
          break;
        }
        case PIECES.W_ROOK: case PIECES.B_ROOK: {
          let m = 0;
          for (let i = 0; i < 8; i += 2) {
            const dr = ROOK_OFFSETS[i], dc = ROOK_OFFSETS[i + 1];
            let tr = r + dr, tc = c + dc;
            while (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
              const t = board[tr][tc];
              if (t && ((t >= 1 && t <= 6) === isW)) break;
              if (!enemyAtk[tr * 8 + tc]) m++;
              if (t) break;
              tr += dr; tc += dc;
            }
          }
          mg += sign * m * 2;
          eg += sign * m * 4;

          // Open / semi-open file
          const ownF = isW ? wPawnFiles[c] : bPawnFiles[c];
          const enF  = isW ? bPawnFiles[c] : wPawnFiles[c];
          if (ownF === 0 && enF === 0) { mg += sign * 15; eg += sign * 10; }
          else if (ownF === 0) { mg += sign * 10; eg += sign * 5; }
          break;
        }
        case PIECES.W_QUEEN: case PIECES.B_QUEEN: {
          let m = 0;
          for (let i = 0; i < 16; i += 2) {
            const dr = QUEEN_OFFSETS[i], dc = QUEEN_OFFSETS[i + 1];
            let tr = r + dr, tc = c + dc;
            while (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
              const t = board[tr][tc];
              if (t && ((t >= 1 && t <= 6) === isW)) break;
              if (!enemyAtk[tr * 8 + tc]) m++;
              if (t) break;
              tr += dr; tc += dc;
            }
          }
          mg += sign * m * 1;
          eg += sign * m * 2;
          break;
        }
      }
    }
  }

  // ============================================================
  // King safety (mainly MG; fades in EG)
  // ============================================================
  const ksDelta = evaluateKingSafety(board, WHITE) - evaluateKingSafety(board, BLACK);
  mg += ksDelta;
  eg += ksDelta >> 2;

  // ============================================================
  // Endgame mate heuristic ("home-made" tablebase replacement).
  // When one side is reduced to a bare king and the other has at
  // least one minor/major piece, add bonuses that drive the search
  // toward mate: push the lone king to the edge/corner, and bring
  // the strong king close. This makes KQK, KRK, KQK+P, KBNK, etc.,
  // finish reliably without an external endgame database.
  // ============================================================
  let wK_r=-1, wK_c=-1, bK_r=-1, bK_c=-1;
  let wPieces=0, bPieces=0;     // non-king, non-pawn count
  let wPawnsTot=0, bPawnsTot=0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      switch (p) {
        case PIECES.W_KING:   wK_r=r; wK_c=c; break;
        case PIECES.B_KING:   bK_r=r; bK_c=c; break;
        case PIECES.W_PAWN:   wPawnsTot++; break;
        case PIECES.B_PAWN:   bPawnsTot++; break;
        case PIECES.W_KNIGHT: case PIECES.W_BISHOP:
        case PIECES.W_ROOK:   case PIECES.W_QUEEN: wPieces++; break;
        case PIECES.B_KNIGHT: case PIECES.B_BISHOP:
        case PIECES.B_ROOK:   case PIECES.B_QUEEN: bPieces++; break;
      }
    }
  }
  const blackBare = (bPawnsTot === 0 && bPieces === 0);
  const whiteBare = (wPawnsTot === 0 && wPieces === 0);
  if (blackBare && !whiteBare && wPieces >= 1) {
    const edgeDist = Math.min(bK_r, 7 - bK_r, bK_c, 7 - bK_c);
    const kingDist = Math.max(Math.abs(wK_r - bK_r), Math.abs(wK_c - bK_c));
    // Push enemy king toward edge; bring strong king close.
    eg += (3 - edgeDist) * 20 + (7 - kingDist) * 12;
  } else if (whiteBare && !blackBare && bPieces >= 1) {
    const edgeDist = Math.min(wK_r, 7 - wK_r, wK_c, 7 - wK_c);
    const kingDist = Math.max(Math.abs(wK_r - bK_r), Math.abs(wK_c - bK_c));
    eg -= (3 - edgeDist) * 20 + (7 - kingDist) * 12;
  }

  return Math.round((mg * phase + eg * egPhase) / MAX_PHASE);
}

function evaluateForPlayer(game) {
  const raw = evaluate(game);
  return game.turn === WHITE ? raw : -raw;
}

// -------------------------------------------------------
//  Static Exchange Evaluation (SEE)
//
//  Returns the material gain/loss for a capture on the
//  destination square, assuming both sides always recapture
//  with the least-valuable attacker (LVA). Used for move
//  ordering and for pruning losing captures in quiescence.
//
//  Implementation mutates `board` in-place during the
//  simulation, then restores it via an undo stack. X-ray
//  attackers (a slider behind another slider on the same
//  ray) are handled automatically: when the front piece is
//  removed, the next findLVA scan sees the rear piece.
//
//  The search is single-threaded per worker so the static
//  scratch buffers below are safe.
// -------------------------------------------------------
const SEE_VALUES = {
  [PIECES.W_PAWN]: 100,   [PIECES.B_PAWN]: 100,
  [PIECES.W_KNIGHT]: 320, [PIECES.B_KNIGHT]: 320,
  [PIECES.W_BISHOP]: 330, [PIECES.B_BISHOP]: 330,
  [PIECES.W_ROOK]: 500,   [PIECES.B_ROOK]: 500,
  [PIECES.W_QUEEN]: 900,  [PIECES.B_QUEEN]: 900,
  [PIECES.W_KING]: 20000, [PIECES.B_KING]: 20000,
};

// Output globals — avoid allocating a result object per LVA call.
let _LVA_PIECE = 0, _LVA_R = 0, _LVA_C = 0;

function findLVA(board, tr, tc, color) {
  // Pawn — attacks come from one row ahead of the target (from the attacker's perspective).
  const pawn = color === WHITE ? PIECES.W_PAWN : PIECES.B_PAWN;
  const pawnFromR = color === WHITE ? tr + 1 : tr - 1;
  if (pawnFromR >= 0 && pawnFromR < 8) {
    if (tc > 0 && board[pawnFromR][tc - 1] === pawn) {
      _LVA_PIECE = pawn; _LVA_R = pawnFromR; _LVA_C = tc - 1; return true;
    }
    if (tc < 7 && board[pawnFromR][tc + 1] === pawn) {
      _LVA_PIECE = pawn; _LVA_R = pawnFromR; _LVA_C = tc + 1; return true;
    }
  }

  const knight = color === WHITE ? PIECES.W_KNIGHT : PIECES.B_KNIGHT;
  for (let i = 0; i < 16; i += 2) {
    const r = tr + KNIGHT_OFFSETS[i], c = tc + KNIGHT_OFFSETS[i + 1];
    if (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === knight) {
      _LVA_PIECE = knight; _LVA_R = r; _LVA_C = c; return true;
    }
  }

  // Diagonal: look for a bishop first (cheaper than queen).
  const bishop = color === WHITE ? PIECES.W_BISHOP : PIECES.B_BISHOP;
  for (let i = 0; i < 8; i += 2) {
    const dr = BISHOP_OFFSETS[i], dc = BISHOP_OFFSETS[i + 1];
    let r = tr + dr, c = tc + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const p = board[r][c];
      if (p) { if (p === bishop) { _LVA_PIECE = p; _LVA_R = r; _LVA_C = c; return true; } break; }
      r += dr; c += dc;
    }
  }

  const rook = color === WHITE ? PIECES.W_ROOK : PIECES.B_ROOK;
  for (let i = 0; i < 8; i += 2) {
    const dr = ROOK_OFFSETS[i], dc = ROOK_OFFSETS[i + 1];
    let r = tr + dr, c = tc + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const p = board[r][c];
      if (p) { if (p === rook) { _LVA_PIECE = p; _LVA_R = r; _LVA_C = c; return true; } break; }
      r += dr; c += dc;
    }
  }

  const queen = color === WHITE ? PIECES.W_QUEEN : PIECES.B_QUEEN;
  for (let i = 0; i < 16; i += 2) {
    const dr = QUEEN_OFFSETS[i], dc = QUEEN_OFFSETS[i + 1];
    let r = tr + dr, c = tc + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const p = board[r][c];
      if (p) { if (p === queen) { _LVA_PIECE = p; _LVA_R = r; _LVA_C = c; return true; } break; }
      r += dr; c += dc;
    }
  }

  const king = color === WHITE ? PIECES.W_KING : PIECES.B_KING;
  for (let i = 0; i < 16; i += 2) {
    const r = tr + KING_OFFSETS[i], c = tc + KING_OFFSETS[i + 1];
    if (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === king) {
      _LVA_PIECE = king; _LVA_R = r; _LVA_C = c; return true;
    }
  }

  return false;
}

// Undo stack: entries are [row, col, oldValue] packed as 3 consecutive ints.
const _SEE_STACK = new Int32Array(192); // up to 64 mutations
const _SEE_GAIN  = new Int32Array(64);

function see(board, move) {
  const [fr, fc] = move.from;
  const [tr, tc] = move.to;
  const attacker = board[fr][fc];
  let victim = board[tr][tc];

  // En passant — the captured pawn isn't on the destination square; clear it
  // before the recapture simulation so X-ray attackers see the right occupancy.
  let epRow = -1, epPiece = 0;
  if (move.enPassant) {
    epRow = (attacker >= 1 && attacker <= 6) ? tr + 1 : tr - 1;
    epPiece = board[epRow][tc];
    victim = epPiece;
  }
  if (!victim) return 0;

  let st = 0;
  _SEE_STACK[st++] = tr; _SEE_STACK[st++] = tc; _SEE_STACK[st++] = board[tr][tc];
  _SEE_STACK[st++] = fr; _SEE_STACK[st++] = fc; _SEE_STACK[st++] = attacker;
  board[tr][tc] = attacker;
  board[fr][fc] = 0;
  if (move.enPassant) {
    _SEE_STACK[st++] = epRow; _SEE_STACK[st++] = tc; _SEE_STACK[st++] = epPiece;
    board[epRow][tc] = 0;
  }

  _SEE_GAIN[0] = SEE_VALUES[victim] || 0;
  let onSquare = SEE_VALUES[attacker] || 0;
  let stm = (attacker >= 1 && attacker <= 6) ? BLACK : WHITE;
  let d = 0;

  while (true) {
    d++;
    if (!findLVA(board, tr, tc, stm)) { d--; break; }
    _SEE_GAIN[d] = onSquare - _SEE_GAIN[d - 1];
    // Standard SEE pruning: side-to-move at this depth wouldn't initiate
    // the capture if both halting (-gain[d-1]) and continuing (gain[d]) lose material.
    const a = -_SEE_GAIN[d - 1], b = _SEE_GAIN[d];
    if ((a > b ? a : b) < 0) break;

    onSquare = SEE_VALUES[_LVA_PIECE] || 0;
    _SEE_STACK[st++] = _LVA_R; _SEE_STACK[st++] = _LVA_C; _SEE_STACK[st++] = board[_LVA_R][_LVA_C];
    board[_LVA_R][_LVA_C] = 0;
    _SEE_STACK[st++] = tr; _SEE_STACK[st++] = tc; _SEE_STACK[st++] = board[tr][tc];
    board[tr][tc] = _LVA_PIECE;

    stm = stm === WHITE ? BLACK : WHITE;
    if (d >= 31) break; // safety cap
  }

  // Restore board state (reverse order)
  while (st > 0) {
    const v = _SEE_STACK[--st];
    const c = _SEE_STACK[--st];
    const r = _SEE_STACK[--st];
    board[r][c] = v;
  }

  // Negamax through the gain chain
  while (d > 0) {
    const a = -_SEE_GAIN[d - 1], b = _SEE_GAIN[d];
    _SEE_GAIN[d - 1] = -(a > b ? a : b);
    d--;
  }
  return _SEE_GAIN[0];
}

// -------------------------------------------------------
//  Move ordering helpers
// -------------------------------------------------------
function movesEqual(a, b) {
  return (
    b &&
    a.from[0] === b.from[0] &&
    a.from[1] === b.from[1] &&
    a.to[0] === b.to[0] &&
    a.to[1] === b.to[1]
  );
}

function scoreMoveForOrdering(move, board, ttMove, killers, history, ply) {
  if (ttMove && movesEqual(move, ttMove)) return 2_000_000;

  const [fr, fc] = move.from;
  const [tr, tc] = move.to;
  const victim = board[tr][tc];
  const attacker = board[fr][fc];

  if (victim) {
    // SEE-aware capture ordering. Good/equal captures rank above killers;
    // losing captures fall below quiet moves so the search visits them last.
    const s = see(board, move);
    return s >= 0 ? 1_000_000 + s : -500_000 + s;
  }
  if (move.enPassant) return 1_000_000 + 100;
  if (move.promotion) return 900_000 + (PIECE_VALUES[move.promotion] || 0);

  const k = killers[ply];
  if (k) {
    if (movesEqual(move, k[0])) return 700_000;
    if (movesEqual(move, k[1])) return 600_000;
  }

  return history[attacker] ? history[attacker][tr * 8 + tc] || 0 : 0;
}

function orderMoves(moves, board, ttMove, killers, history, ply) {
  // Score once per move (SEE is expensive — avoid calling it from the comparator).
  const scored = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) {
    scored[i] = { m: moves[i], s: scoreMoveForOrdering(moves[i], board, ttMove, killers, history, ply) };
  }
  scored.sort((a, b) => b.s - a.s);
  const out = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) out[i] = scored[i].m;
  return out;
}

// -------------------------------------------------------
//  Opening book — small in-memory home book
//  Built from a list of main-line UCI strings.
//  For each position reached along a line, we record the
//  next move with cumulative weight (popular = more weight).
//  Probe = single Zobrist lookup + weighted random pick.
// -------------------------------------------------------
const _BOOK_LINES = [
  // 1.e4 e5 — Italian, Spanish, Petroff, Scotch
  "e2e4 e7e5",
  "e2e4 e7e5 g1f3",
  "e2e4 e7e5 g1f3 b8c6",
  "e2e4 e7e5 g1f3 b8c6 f1c4",
  "e2e4 e7e5 g1f3 b8c6 f1c4 g8f6",
  "e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3",
  "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5",
  "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3",
  "e2e4 e7e5 g1f3 b8c6 f1b5",
  "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6",
  "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4",
  "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6",
  "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1",
  "e2e4 e7e5 g1f3 b8c6 f1b5 g8f6",
  "e2e4 e7e5 g1f3 g8f6",
  "e2e4 e7e5 g1f3 g8f6 f3e5",
  "e2e4 e7e5 g1f3 g8f6 f3e5 d7d6",
  "e2e4 e7e5 g1f3 b8c6 d2d4",
  "e2e4 e7e5 g1f3 b8c6 d2d4 e5d4",
  "e2e4 e7e5 g1f3 b8c6 b1c3",
  "e2e4 e7e5 b1c3",
  // Sicilian
  "e2e4 c7c5",
  "e2e4 c7c5 g1f3",
  "e2e4 c7c5 g1f3 d7d6",
  "e2e4 c7c5 g1f3 d7d6 d2d4",
  "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4",
  "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4",
  "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6",
  "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3",
  "e2e4 c7c5 g1f3 b8c6",
  "e2e4 c7c5 g1f3 b8c6 d2d4",
  "e2e4 c7c5 g1f3 b8c6 d2d4 c5d4",
  "e2e4 c7c5 g1f3 e7e6",
  "e2e4 c7c5 g1f3 e7e6 d2d4",
  "e2e4 c7c5 g1f3 e7e6 d2d4 c5d4",
  "e2e4 c7c5 b1c3",
  "e2e4 c7c5 b1c3 b8c6",
  // French
  "e2e4 e7e6",
  "e2e4 e7e6 d2d4",
  "e2e4 e7e6 d2d4 d7d5",
  "e2e4 e7e6 d2d4 d7d5 b1c3",
  "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6",
  "e2e4 e7e6 d2d4 d7d5 e4e5",
  "e2e4 e7e6 d2d4 d7d5 e4e5 c7c5",
  // Caro-Kann
  "e2e4 c7c6",
  "e2e4 c7c6 d2d4",
  "e2e4 c7c6 d2d4 d7d5",
  "e2e4 c7c6 d2d4 d7d5 b1c3",
  "e2e4 c7c6 d2d4 d7d5 b1c3 d5e4",
  "e2e4 c7c6 d2d4 d7d5 e4e5",
  "e2e4 c7c6 d2d4 d7d5 e4d5",
  // Scandinavian
  "e2e4 d7d5",
  "e2e4 d7d5 e4d5",
  "e2e4 d7d5 e4d5 d8d5",
  // Alekhine
  "e2e4 g8f6",
  "e2e4 g8f6 e4e5",
  "e2e4 g8f6 e4e5 f6d5",
  // Pirc / Modern
  "e2e4 d7d6",
  "e2e4 d7d6 d2d4",
  "e2e4 g7g6",
  "e2e4 g7g6 d2d4",
  // 1.d4 lines
  "d2d4 d7d5",
  "d2d4 d7d5 c2c4",
  "d2d4 d7d5 c2c4 e7e6",
  "d2d4 d7d5 c2c4 e7e6 b1c3",
  "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6",
  "d2d4 d7d5 c2c4 c7c6",
  "d2d4 d7d5 c2c4 c7c6 g1f3",
  "d2d4 d7d5 c2c4 d5c4",
  "d2d4 d7d5 c2c4 d5c4 g1f3",
  "d2d4 g8f6",
  "d2d4 g8f6 c2c4",
  "d2d4 g8f6 c2c4 e7e6",
  "d2d4 g8f6 c2c4 e7e6 b1c3",
  "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4",
  "d2d4 g8f6 c2c4 g7g6",
  "d2d4 g8f6 c2c4 g7g6 b1c3",
  "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7",
  "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4",
  "d2d4 g8f6 g1f3",
  "d2d4 g8f6 g1f3 e7e6",
  "d2d4 g8f6 g1f3 g7g6",
  "d2d4 f7f5",
  "d2d4 f7f5 g2g3",
  // English
  "c2c4",
  "c2c4 e7e5",
  "c2c4 e7e5 b1c3",
  "c2c4 g8f6",
  "c2c4 g8f6 b1c3",
  "c2c4 c7c5",
  "c2c4 e7e6",
  // Reti
  "g1f3",
  "g1f3 d7d5",
  "g1f3 g8f6",
  "g1f3 d7d5 c2c4",
  // Less common but solid
  "e2e4",
  "d2d4",
];

function _uciToMove(game, uci) {
  if (!uci || uci.length < 4) return null;
  const fc = uci.charCodeAt(0) - 97;
  const fr = 8 - parseInt(uci[1], 10);
  const tc = uci.charCodeAt(2) - 97;
  const tr = 8 - parseInt(uci[3], 10);
  let promo = null;
  if (uci.length >= 5) {
    const isWhite = game.turn === WHITE;
    switch (uci[4]) {
      case 'q': promo = isWhite ? PIECES.W_QUEEN  : PIECES.B_QUEEN;  break;
      case 'r': promo = isWhite ? PIECES.W_ROOK   : PIECES.B_ROOK;   break;
      case 'b': promo = isWhite ? PIECES.W_BISHOP : PIECES.B_BISHOP; break;
      case 'n': promo = isWhite ? PIECES.W_KNIGHT : PIECES.B_KNIGHT; break;
    }
  }
  const legal = game.getLegalMoves(game.turn);
  for (const m of legal) {
    if (m.from[0] === fr && m.from[1] === fc &&
        m.to[0]   === tr && m.to[1]   === tc &&
        (m.promotion || null) === promo) {
      return m;
    }
  }
  return null;
}

class OpeningBook {
  constructor(lines) {
    this.entries = new Map();
    this._build(lines);
  }

  _build(lines) {
    for (const lineStr of lines) {
      const ucis = lineStr.trim().split(/\s+/);
      const game = new ChessGame();
      for (const uci of ucis) {
        const move = _uciToMove(game, uci);
        if (!move) break;
        const key = computeZobrist(game);
        let list = this.entries.get(key);
        if (!list) {
          list = [];
          this.entries.set(key, list);
        }
        let found = null;
        for (const e of list) {
          if (e.move.from[0] === move.from[0] && e.move.from[1] === move.from[1] &&
              e.move.to[0]   === move.to[0]   && e.move.to[1]   === move.to[1] &&
              (e.move.promotion || null) === (move.promotion || null)) {
            found = e; break;
          }
        }
        if (found) found.weight++;
        else list.push({ move, weight: 1 });
        game.makeMove(move);
      }
    }
  }

  // Returns a legal move from the current position if known, else null.
  // Picks weighted-randomly among book moves so the bot doesn't always
  // play the same line.
  // minWeight: ignore book moves that occurred fewer than this many times
  //            across the corpus — drops one-off fantasies seen 1/50,000
  //            without dropping mainstream alternatives. We relax to 1 if
  //            no entry meets the threshold (small inline book case).
  probe(game, minWeight = this.minProbeWeight || 3) {
    const list = this.entries.get(computeZobrist(game));
    if (!list || list.length === 0) return null;

    const legal = game.getLegalMoves(game.turn);
    const valid = [];
    let total = 0;
    for (const e of list) {
      if (e.weight < minWeight) continue;
      for (const m of legal) {
        if (m.from[0] === e.move.from[0] && m.from[1] === e.move.from[1] &&
            m.to[0]   === e.move.to[0]   && m.to[1]   === e.move.to[1] &&
            (m.promotion || null) === (e.move.promotion || null)) {
          valid.push({ move: m, weight: e.weight });
          total += e.weight;
          break;
        }
      }
    }
    // Fallback: if the threshold filtered everything (typical for inline-book
    // positions where every move has weight 1), retry with no threshold.
    if (valid.length === 0 && minWeight > 1) return this.probe(game, 1);
    if (valid.length === 0) return null;

    let r = Math.random() * total;
    for (const v of valid) {
      r -= v.weight;
      if (r <= 0) return v.move;
    }
    return valid[0].move;
  }

  size() { return this.entries.size; }
}

const _OPENING_BOOK = new OpeningBook(_BOOK_LINES);

// -------------------------------------------------------
//  SAN (Standard Algebraic Notation) parser
//  Parses one move (e.g. "Nxe5", "exd6+", "O-O-O", "e8=Q")
//  against the current legal moves of `game`.
// -------------------------------------------------------
function _sanToMove(game, san) {
  if (!san) return null;
  san = san.replace(/[+#!?]+$/g, '');
  const isW = game.turn === WHITE;
  const legal = game.getLegalMoves(game.turn);

  // Castling
  if (san === 'O-O' || san === '0-0') {
    const home = isW ? 7 : 0;
    for (const m of legal) {
      if (m.from[0] === home && m.from[1] === 4 &&
          m.to[0]   === home && m.to[1] === 6) return m;
    }
    return null;
  }
  if (san === 'O-O-O' || san === '0-0-0') {
    const home = isW ? 7 : 0;
    for (const m of legal) {
      if (m.from[0] === home && m.from[1] === 4 &&
          m.to[0]   === home && m.to[1] === 2) return m;
    }
    return null;
  }

  // Promotion suffix (=Q, =R, etc.)
  let promo = null;
  const eqIdx = san.indexOf('=');
  if (eqIdx >= 0) {
    const c = san[eqIdx + 1];
    promo = ({
      Q: isW ? PIECES.W_QUEEN  : PIECES.B_QUEEN,
      R: isW ? PIECES.W_ROOK   : PIECES.B_ROOK,
      B: isW ? PIECES.W_BISHOP : PIECES.B_BISHOP,
      N: isW ? PIECES.W_KNIGHT : PIECES.B_KNIGHT,
    })[c] || null;
    san = san.substring(0, eqIdx);
  }

  // Piece type (default: pawn)
  let pieceChar = 'P';
  let body = san;
  if ('NBRQK'.includes(san[0])) {
    pieceChar = san[0];
    body = san.substring(1);
  }
  body = body.replace('x', '');
  if (body.length < 2) return null;

  const dst = body.substring(body.length - 2);
  const dstC = dst.charCodeAt(0) - 97;
  const dstR = 8 - parseInt(dst[1], 10);
  if (dstC < 0 || dstC > 7 || dstR < 0 || dstR > 7) return null;

  const disamb = body.substring(0, body.length - 2);
  let fromFile = -1, fromRank = -1;
  for (const ch of disamb) {
    if (ch >= 'a' && ch <= 'h') fromFile = ch.charCodeAt(0) - 97;
    else if (ch >= '1' && ch <= '8') fromRank = 8 - parseInt(ch, 10);
  }

  const pieceCode = ({
    P: isW ? PIECES.W_PAWN   : PIECES.B_PAWN,
    N: isW ? PIECES.W_KNIGHT : PIECES.B_KNIGHT,
    B: isW ? PIECES.W_BISHOP : PIECES.B_BISHOP,
    R: isW ? PIECES.W_ROOK   : PIECES.B_ROOK,
    Q: isW ? PIECES.W_QUEEN  : PIECES.B_QUEEN,
    K: isW ? PIECES.W_KING   : PIECES.B_KING,
  })[pieceChar];

  let found = null;
  for (const m of legal) {
    if (m.to[0] !== dstR || m.to[1] !== dstC) continue;
    if (game.board[m.from[0]][m.from[1]] !== pieceCode) continue;
    if (fromFile >= 0 && m.from[1] !== fromFile) continue;
    if (fromRank >= 0 && m.from[0] !== fromRank) continue;
    if ((m.promotion || null) !== promo) continue;
    if (found) return null; // ambiguous (shouldn't happen for valid SAN)
    found = m;
  }
  return found;
}

// -------------------------------------------------------
//  PGN parser — extracts move sequence + metadata per game.
//  Returns Array<{tokens, whiteElo, blackElo, result}>.
//  Strips headers, comments {...}, variations (...), NAGs $N,
//  move numbers and result indicator.
// -------------------------------------------------------
function _parsePGN(text) {
  const games = [];
  const blocks = text.split(/\n\s*(?=\[Event )/);
  const tokenRe = /^(O-O-O|O-O|[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?)$/;
  const headerRe = /\[(\w+)\s+"([^"]*)"\]/g;

  for (const block of blocks) {
    // Pull metadata headers
    let whiteElo = 0, blackElo = 0, result = '*';
    headerRe.lastIndex = 0;
    let h;
    while ((h = headerRe.exec(block)) !== null) {
      const k = h[1];
      if (k === 'WhiteElo') whiteElo = parseInt(h[2], 10) || 0;
      else if (k === 'BlackElo') blackElo = parseInt(h[2], 10) || 0;
      else if (k === 'Result') result = h[2];
    }

    const moveText = block.replace(/^\s*(\[[^\]]*\]\s*)+/gm, '');
    let cleaned = moveText.replace(/\{[^}]*\}/g, ' ');
    // Strip variations (handles nesting)
    let depth = 0, out = '';
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth = depth > 0 ? depth - 1 : 0;
      else if (depth === 0) out += ch;
    }
    cleaned = out
      .replace(/\$\d+/g, ' ')
      .replace(/\d+\.(\.\.)?/g, ' ')
      .replace(/(1-0|0-1|1\/2-1\/2|\*)/g, ' ');

    const tokens = [];
    for (const t of cleaned.split(/\s+/)) {
      if (t && tokenRe.test(t)) tokens.push(t);
    }
    if (tokens.length > 0) games.push({ tokens, whiteElo, blackElo, result });
  }
  return games;
}

// Add games from PGN into the existing book.
// opts:
//   maxPly  — how deep to record per game (default 40 plies = 20 moves each)
//   minElo  — drop games where either player is below this Elo (0 = no filter)
//   winnerOnly — if true, only record moves played by the side that WON the
//                game (draws keep both sides). This is the key quality filter:
//                a bad opening that lost gets no entry in the book.
OpeningBook.prototype.addFromGames = function (games, opts = {}) {
  const maxPly      = opts.maxPly      != null ? opts.maxPly      : 40;
  const minElo      = opts.minElo      != null ? opts.minElo      : 0;
  const winnerOnly  = opts.winnerOnly  != null ? opts.winnerOnly  : true;

  let added = 0, gamesUsed = 0, gamesDropped = 0;

  for (const g of games) {
    // Backward-compat: g may be either {tokens,...} or raw array of SAN
    const sans = Array.isArray(g) ? g : g.tokens;
    const wElo = g.whiteElo || 0;
    const bElo = g.blackElo || 0;
    const result = g.result || '*';

    if (minElo > 0 && (wElo > 0 || bElo > 0)) {
      if (wElo < minElo || bElo < minElo) { gamesDropped++; continue; }
    }

    // Decide which side's moves we record
    let addWhite = true, addBlack = true;
    if (winnerOnly) {
      if (result === '1-0')      { addWhite = true;  addBlack = false; }
      else if (result === '0-1') { addWhite = false; addBlack = true;  }
      else if (result === '1/2-1/2') { /* keep both */ }
      else { gamesDropped++; continue; } // unfinished / unknown — skip entirely
    }

    gamesUsed++;
    const game = new ChessGame();
    const limit = Math.min(sans.length, maxPly);
    for (let i = 0; i < limit; i++) {
      const move = _sanToMove(game, sans[i]);
      if (!move) break;

      const isWhitePly = (i % 2) === 0;
      const shouldAdd = isWhitePly ? addWhite : addBlack;
      if (shouldAdd) {
        const key = computeZobrist(game);
        let list = this.entries.get(key);
        if (!list) {
          list = [];
          this.entries.set(key, list);
        }
        let found = null;
        for (const e of list) {
          if (e.move.from[0] === move.from[0] && e.move.from[1] === move.from[1] &&
              e.move.to[0]   === move.to[0]   && e.move.to[1]   === move.to[1] &&
              (e.move.promotion || null) === (move.promotion || null)) {
            found = e; break;
          }
        }
        if (found) found.weight++;
        else list.push({ move, weight: 1 });
        added++;
      }
      game.makeMove(move);
    }
  }
  return { added, gamesUsed, gamesDropped };
};

// Async-load a `book.pgn` file from the same origin (next to ai.worker.js
// when running in the worker, or next to index.html in the main thread).
// Gracefully degrades to the inline book if not found.
// The book is usable immediately; PGN positions add on top as they parse.
(function _autoLoadExtendedBook() {
  if (typeof fetch === 'undefined') return;
  fetch('book.pgn')
    .then(r => r.ok ? r.text() : null)
    .then(text => {
      if (!text) return;
      const t0 = Date.now();
      const games = _parsePGN(text);
      const stats = _OPENING_BOOK.addFromGames(games, {
        maxPly:     40,
        minElo:     2200,   // drop games where either player is weaker
        winnerOnly: true,   // only follow the winner's moves; nulles = both
      });
      // Once a real book is loaded, the probe-time minimum-weight threshold
      // protects against rare one-off lines being picked.
      _OPENING_BOOK.minProbeWeight = 3;
      const ms = Date.now() - t0;
      if (typeof console !== 'undefined') {
        console.log(
          `[book] PGN loaded in ${ms}ms — ` +
          `${games.length} games parsed, ${stats.gamesUsed} kept (min Elo + winner-only), ` +
          `${stats.gamesDropped} dropped, ${stats.added} move-records, ` +
          `${_OPENING_BOOK.size()} unique positions`
        );
      }
    })
    .catch(() => { /* silently fall back to inline book */ });
})();

// -------------------------------------------------------
//  ChessAI — Time-based iterative deepening
// -------------------------------------------------------
class ChessAI {
  constructor() {
    this.tt = new TranspositionTable();
    this.nodesEvaluated = 0;
    this.bestMoveFound = null;
    this.calcTime = 0;
    this.lastScore = 0;
    this.depthReached = 0;
    this._startTime = 0;
    this._timeLimit = 10000;
    this._aborted = false;
    this._iterBestMove = null;
    this._resetSearchState();
  }

  _resetSearchState() {
    this.killers = Array.from({ length: 64 }, () => [null, null]);
    this.history = Array.from({ length: 13 }, () => new Int32Array(64));
  }

  // timeLimitMs: max milliseconds to search (default 10s)
  findBestMove(game, timeLimitMs = 10000) {
    // Safety: make sure the incremental eval state matches the board.
    // Required when the worker reconstructs `game` from a serialized state
    // without copying psqt/material/phase.
    game._recomputeEvalState();

    this.nodesEvaluated = 0;
    this.bestMoveFound = null;
    this.depthReached = 0;
    this._aborted = false;
    this._startTime = Date.now();
    this._timeLimit = timeLimitMs;
    this._resetSearchState();

    // --- Opening book lookup ---
    // Probe the book up to move 25. With a large PGN-fed book, real games
    // can still be in theory at move 20+. A miss is essentially free
    // (one hash + one Map.get), so a high cap costs nothing when the
    // position has dropped out of theory.
    if (game.fullMoveNumber <= 25) {
      const bookMove = _OPENING_BOOK.probe(game);
      if (bookMove) {
        this.bestMoveFound = bookMove;
        this.lastScore = 0;
        this.depthReached = 0;
        this.calcTime = Date.now() - this._startTime;
        return bookMove;
      }
    }

    let lastScore = 0;
    for (let d = 1; d <= 50; d++) {
      // Don't start a new iteration if we're already over the limit
      if (d > 1 && Date.now() - this._startTime >= timeLimitMs) break;

      // --- Aspiration window ---
      // For shallow depths or mate scores, fall back to the full window so
      // an early bad estimate can't waste time on repeated re-searches.
      // Otherwise start tight around the previous iteration's score and
      // widen only the side that fails.
      let alpha, beta;
      let delta = 50;
      let score = 0;

      if (d < 4 || Math.abs(lastScore) >= 90000) {
        alpha = -200000;
        beta  =  200000;
      } else {
        alpha = lastScore - delta;
        beta  = lastScore + delta;
      }

      while (true) {
        this._aborted = false;
        this._iterBestMove = null;
        score = this._negamax(game, d, alpha, beta, 0, true);

        if (this._aborted) break;

        if (score <= alpha) {
          // Fail-low: widen alpha, keep beta
          delta *= 2;
          alpha = lastScore - delta;
          if (delta > 1000) alpha = -200000;
        } else if (score >= beta) {
          // Fail-high: widen beta, keep alpha
          delta *= 2;
          beta = lastScore + delta;
          if (delta > 1000) beta = 200000;
        } else {
          break; // within window — accept
        }

        if (Date.now() - this._startTime >= this._timeLimit) {
          this._aborted = true;
          break;
        }
      }

      if (this._aborted) break; // Iteration incomplete — keep result from d-1

      // Iteration completed cleanly
      if (this._iterBestMove) this.bestMoveFound = this._iterBestMove;
      lastScore = score;
      this.depthReached = d;

      if (Math.abs(lastScore) >= 99000) break; // Mate found
      if (Date.now() - this._startTime >= timeLimitMs) break;
    }

    this.calcTime = Date.now() - this._startTime;
    this.lastScore = game.turn === WHITE ? lastScore : -lastScore;

    if (!this.bestMoveFound) {
      const moves = game.getLegalMoves(game.turn);
      if (moves.length > 0) this.bestMoveFound = moves[0];
    }

    return this.bestMoveFound;
  }

  // -------------------------------------------------------
  //  Negamax avec Alpha-Beta, TT, Null Move, Killers,
  //  History et LMR
  //  allowNullMove: false after a null move to prevent
  //  consecutive null moves (which cause incorrect pruning)
  // -------------------------------------------------------
  _negamax(game, depth, alpha, beta, ply, allowNullMove) {
    this.nodesEvaluated++;

    // Check time every 4096 nodes
    if ((this.nodesEvaluated & 0xfff) === 0) {
      if (Date.now() - this._startTime >= this._timeLimit) this._aborted = true;
    }
    if (this._aborted) return 0;

    const origAlpha = alpha;

    // --- Probe TT ---
    const hash = computeZobrist(game);
    const ttHit = this.tt.probe(hash);
    let ttMove = null;

    if (ttHit) {
      ttMove = ttHit.move;
      if (ttHit.depth >= depth) {
        // Denormalize mate scores: TT stores position-relative scores,
        // but search uses root-relative scores. Adjust by current ply.
        let ttScore = ttHit.score;
        if (ttScore > 90000) ttScore = ttScore - ply;
        if (ttScore < -90000) ttScore = ttScore + ply;
        if (ttHit.flag === TT_EXACT) return ttScore;
        if (ttHit.flag === TT_LOWER) alpha = Math.max(alpha, ttScore);
        if (ttHit.flag === TT_UPPER) beta = Math.min(beta, ttScore);
        if (alpha >= beta) return ttScore;
      }
    }

    if (depth === 0) return this._quiescence(game, alpha, beta, ply, 6);

    const color = game.turn;
    const inCheck = game.isInCheck(color);
    const isPvNode = (beta - alpha) > 1;

    // Static eval is needed for futility / razoring. Compute lazily; cache
    // for the rest of this call.
    let staticEval = null;

    // --- Reverse futility (static null move) pruning ---
    // If our static eval is already so far above beta that no plausible move
    // could drop us below it, return the bound directly. Skip in PV nodes,
    // when in check, and near mate scores.
    if (!inCheck && !isPvNode && depth <= 6 && Math.abs(beta) < 90000) {
      staticEval = evaluateForPlayer(game);
      const margin = depth * 100;
      if (staticEval - margin >= beta) return staticEval - margin;
    }

    // --- Razoring ---
    // If static eval + a generous margin is still below alpha, drop into
    // quiescence with a null window; if qsearch confirms we can't reach
    // alpha, prune.
    if (!inCheck && !isPvNode && depth <= 3 && Math.abs(alpha) < 90000) {
      if (staticEval === null) staticEval = evaluateForPlayer(game);
      const margin = 200 + depth * 100;
      if (staticEval + margin < alpha) {
        const qScore = this._quiescence(game, alpha - 1, alpha, ply, 6);
        if (qScore < alpha) return qScore;
      }
    }

    // --- Null Move Pruning ---
    // allowNullMove=false prevents consecutive null moves, which would
    // give the opponent two free moves and cause massive over-pruning.
    if (
      allowNullMove &&
      !inCheck &&
      !isPvNode &&
      depth >= 3 &&
      ply > 0 &&
      !this._isEndgame(game)
    ) {
      const R = depth >= 5 ? 3 : 2;
      const saved = game.cloneState();
      game.turn = opponent(color);
      game.enPassantSquare = null; // No en passant after passing
      const nullScore = -this._negamax(
        game,
        depth - R - 1,
        -beta,
        -beta + 1,
        ply + 1,
        false,
      );
      game.restoreState(saved);
      if (!this._aborted && nullScore >= beta) return beta;
    }

    const moves = game.getLegalMoves(color);
    if (moves.length === 0) return inCheck ? -(100000 - ply) : 0;

    const ordered = orderMoves(
      moves,
      game.board,
      ttMove,
      this.killers,
      this.history,
      ply,
    );

    let bestScore = -200000;
    let bestMove = null;

    for (let i = 0; i < ordered.length; i++) {
      if (this._aborted) break;

      const move = ordered[i];
      const isCapture = !!game.board[move.to[0]][move.to[1]] || move.enPassant;
      const isPromotion = !!move.promotion;

      const saved = game.cloneState();
      game._applyMoveNoHistory(move);

      // --- Extensions: spend an extra ply on critical lines ---
      const givesCheck = game.isInCheck(game.turn);
      const extension = (givesCheck || isPromotion) ? 1 : 0;
      const newDepth = depth - 1 + extension;

      let score;

      if (i === 0) {
        // PV move (first in ordering): full window
        score = -this._negamax(game, newDepth, -beta, -alpha, ply + 1, true);
      } else {
        // --- PVS + LMR for later moves ---
        // Skip reductions when extending (check/promotion) — those are exactly
        // the lines we want to look deeper at.
        const useLMR = (
          extension === 0 &&
          i >= 4 && depth >= 3 &&
          !inCheck && !isCapture && !isPromotion && !givesCheck
        );
        if (useLMR) {
          score = -this._negamax(game, newDepth - 1, -alpha - 1, -alpha, ply + 1, true);
          if (!this._aborted && score > alpha) {
            // LMR fails high — try at full depth with null window
            score = -this._negamax(game, newDepth, -alpha - 1, -alpha, ply + 1, true);
          }
        } else {
          // Null-window scout
          score = -this._negamax(game, newDepth, -alpha - 1, -alpha, ply + 1, true);
        }

        // PVS re-search: if scout fell inside (alpha, beta) we need an exact score
        if (!this._aborted && score > alpha && score < beta) {
          score = -this._negamax(game, newDepth, -beta, -alpha, ply + 1, true);
        }
      }

      game.restoreState(saved);

      if (this._aborted) break;

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        if (ply === 0) this._iterBestMove = move; // Track root best for this iteration
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!isCapture && !isPromotion) {
          this.killers[ply][1] = this.killers[ply][0];
          this.killers[ply][0] = move;
          // board is restored, so from-square has the piece back
          const piece = game.board[move.from[0]][move.from[1]];
          if (piece)
            this.history[piece][move.to[0] * 8 + move.to[1]] += depth * depth;
        }
        break;
      }
    }

    if (!this._aborted && bestMove) {
      // Normalize mate scores to position-relative before storing:
      // root-relative score at ply N → add N so retrieval at any ply gives correct root-relative value
      let scoreToStore = bestScore;
      if (scoreToStore > 90000) scoreToStore = scoreToStore + ply;
      if (scoreToStore < -90000) scoreToStore = scoreToStore - ply;
      let flag;
      if (bestScore <= origAlpha) flag = TT_UPPER;
      else if (bestScore >= beta) flag = TT_LOWER;
      else flag = TT_EXACT;
      this.tt.store(hash, depth, scoreToStore, flag, bestMove);
    }

    return bestScore;
  }

  // -------------------------------------------------------
  //  Quiescence search
  //  When in check: search ALL legal moves (king must escape).
  //  Without this, the engine never sees king escapes and
  //  incorrectly values checks as better than they are.
  // -------------------------------------------------------
  _quiescence(game, alpha, beta, ply, maxDepth) {
    this.nodesEvaluated++;
    if (this._aborted) return 0;

    const color = game.turn;
    const inCheck = game.isInCheck(color);
    const standPat = evaluateForPlayer(game);

    if (maxDepth <= 0) return standPat;

    // Stand-pat pruning (not when in check — can't pass)
    if (!inCheck) {
      if (standPat >= beta) return beta;
      if (standPat + 975 < alpha) return alpha; // Delta pruning
      alpha = Math.max(alpha, standPat);
    }

    const allMoves = game.getLegalMoves(color);

    if (allMoves.length === 0) {
      return inCheck ? -(100000 - ply) : standPat;
    }

    // In check → search all legal moves to escape; otherwise only captures/promotions,
    // with SEE pruning to drop losing captures (e.g., QxP defended by a pawn).
    const movesToSearch = inCheck
      ? allMoves
      : allMoves.filter((m) => {
          if (m.promotion) return true;
          const isCapture = !!game.board[m.to[0]][m.to[1]] || m.enPassant;
          if (!isCapture) return false;
          if (m.enPassant) return true; // approximated by see() as +pawn
          return see(game.board, m) >= 0;
        });

    if (movesToSearch.length === 0) return alpha;

    movesToSearch.sort(
      (a, b) =>
        (PIECE_VALUES[game.board[b.to[0]][b.to[1]]] || 0) -
        (PIECE_VALUES[game.board[a.to[0]][a.to[1]]] || 0),
    );

    for (const move of movesToSearch) {
      if (this._aborted) break;
      const saved = game.cloneState();
      game._applyMoveNoHistory(move);
      // Reduce maxDepth faster when in check to prevent sacrificing just to give check
      const nextDepth = inCheck ? maxDepth - 2 : maxDepth - 1;
      const score = -this._quiescence(game, -beta, -alpha, ply + 1, nextDepth);
      game.restoreState(saved);
      if (score >= beta) return beta;
      alpha = Math.max(alpha, score);
    }

    return alpha;
  }

  _isEndgame(game) {
    // Phase <= 8 ≈ no queens and at most one rook side combined.
    return game.phase <= 8;
  }
}
