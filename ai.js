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
//  Piece values & PST tables
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

const PST_PAWN = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [10, 10, 20, 30, 30, 20, 10, 10],
  [5, 5, 10, 25, 25, 10, 5, 5],
  [0, 0, 0, 20, 20, 0, 0, 0],
  [5, -5, -10, 0, 0, -10, -5, 5],
  [5, 10, 10, -20, -20, 10, 10, 5],
  [0, 0, 0, 0, 0, 0, 0, 0],
];
const PST_KNIGHT = [
  [-50, -40, -30, -30, -30, -30, -40, -50],
  [-40, -20, 0, 0, 0, 0, -20, -40],
  [-30, 0, 10, 15, 15, 10, 0, -30],
  [-30, 5, 15, 20, 20, 15, 5, -30],
  [-30, 0, 15, 20, 20, 15, 0, -30],
  [-30, 5, 10, 15, 15, 10, 5, -30],
  [-40, -20, 0, 5, 5, 0, -20, -40],
  [-50, -40, -30, -30, -30, -30, -40, -50],
];
const PST_BISHOP = [
  [-20, -10, -10, -10, -10, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 10, 10, 5, 0, -10],
  [-10, 5, 5, 10, 10, 5, 5, -10],
  [-10, 0, 10, 10, 10, 10, 0, -10],
  [-10, 10, 10, 10, 10, 10, 10, -10],
  [-10, 5, 0, 0, 0, 0, 5, -10],
  [-20, -10, -10, -10, -10, -10, -10, -20],
];
const PST_ROOK = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 10, 10, 10, 10, 10, 10, 5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [0, 0, 0, 5, 5, 0, 0, 0],
];
const PST_QUEEN = [
  [-20, -10, -10, -5, -5, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [0, 0, 5, 5, 5, 5, 0, -5],
  [-10, 5, 5, 5, 5, 5, 0, -10],
  [-10, 0, 5, 0, 0, 0, 0, -10],
  [-20, -10, -10, -5, -5, -10, -10, -20],
];
const PST_KING_MG = [
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-20, -30, -30, -40, -40, -30, -30, -20],
  [-10, -20, -20, -20, -20, -20, -20, -10],
  [20, 20, 0, 0, 0, 0, 20, 20],
  [20, 30, 10, 0, 0, 10, 30, 20],
];
const PST_KING_EG = [
  [-50, -40, -30, -20, -20, -30, -40, -50],
  [-30, -20, -10, 0, 0, -10, -20, -30],
  [-30, -10, 20, 30, 30, 20, -10, -30],
  [-30, -10, 30, 40, 40, 30, -10, -30],
  [-30, -10, 30, 40, 40, 30, -10, -30],
  [-30, -10, 20, 30, 30, 20, -10, -30],
  [-30, -30, 0, 0, 0, 0, -30, -30],
  [-50, -30, -30, -30, -30, -30, -30, -50],
];

function getPST(piece, row, col) {
  const r = isWhitePiece(piece) ? row : 7 - row;
  switch (piece) {
    case PIECES.W_PAWN:
    case PIECES.B_PAWN:
      return PST_PAWN[r][col];
    case PIECES.W_KNIGHT:
    case PIECES.B_KNIGHT:
      return PST_KNIGHT[r][col];
    case PIECES.W_BISHOP:
    case PIECES.B_BISHOP:
      return PST_BISHOP[r][col];
    case PIECES.W_ROOK:
    case PIECES.B_ROOK:
      return PST_ROOK[r][col];
    case PIECES.W_QUEEN:
    case PIECES.B_QUEEN:
      return PST_QUEEN[r][col];
    case PIECES.W_KING:
    case PIECES.B_KING:
      return PST_KING_MG[r][col];
    default:
      return 0;
  }
}

// -------------------------------------------------------
//  Evaluation (positive = white advantage)
// -------------------------------------------------------
function countMaterial(board) {
  let total = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p !== PIECES.W_KING && p !== PIECES.B_KING)
        total += PIECE_VALUES[p];
    }
  return total;
}

function evaluate(game) {
  let score = 0;
  const material = countMaterial(game.board);
  const isEndgame = material < 2600;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = game.board[r][c];
      if (!p) continue;
      const sign = isWhitePiece(p) ? 1 : -1;
      let val = PIECE_VALUES[p];
      if ((p === PIECES.W_KING || p === PIECES.B_KING) && isEndgame) {
        val += PST_KING_EG[isWhitePiece(p) ? r : 7 - r][c];
      } else {
        val += getPST(p, r, c);
      }
      score += sign * val;
    }
  }

  score +=
    (game._getPseudoMoves(WHITE).length - game._getPseudoMoves(BLACK).length) *
    5;

  return score;
}

function evaluateForPlayer(game) {
  const raw = evaluate(game);
  return game.turn === WHITE ? raw : -raw;
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

  if (victim)
    return (
      1_000_000 +
      10 * (PIECE_VALUES[victim] || 0) -
      (PIECE_VALUES[attacker] || 0)
    );
  if (move.promotion) return 900_000 + (PIECE_VALUES[move.promotion] || 0);
  if (move.enPassant) return 800_000;

  const k = killers[ply];
  if (k) {
    if (movesEqual(move, k[0])) return 700_000;
    if (movesEqual(move, k[1])) return 600_000;
  }

  return history[attacker] ? history[attacker][tr * 8 + tc] || 0 : 0;
}

function orderMoves(moves, board, ttMove, killers, history, ply) {
  return moves
    .slice()
    .sort(
      (a, b) =>
        scoreMoveForOrdering(b, board, ttMove, killers, history, ply) -
        scoreMoveForOrdering(a, board, ttMove, killers, history, ply),
    );
}

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
    this.nodesEvaluated = 0;
    this.bestMoveFound = null;
    this.depthReached = 0;
    this._aborted = false;
    this._startTime = Date.now();
    this._timeLimit = timeLimitMs;
    this._resetSearchState();

    let lastScore = 0;
    for (let d = 1; d <= 50; d++) {
      // Don't start a new iteration if we're already over the limit
      if (d > 1 && Date.now() - this._startTime >= timeLimitMs) break;
      this._aborted = false;
      this._iterBestMove = null;
      const score = this._negamax(game, d, -200000, 200000, 0, true);
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

    // --- Null Move Pruning ---
    // allowNullMove=false prevents consecutive null moves, which would
    // give the opponent two free moves and cause massive over-pruning.
    if (
      allowNullMove &&
      !inCheck &&
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

      let score;

      // --- Late Move Reduction (LMR) ---
      if (
        i >= 4 &&
        depth >= 3 &&
        !inCheck &&
        !isCapture &&
        !isPromotion &&
        !game.isInCheck(game.turn)
      ) {
        score = -this._negamax(
          game,
          depth - 2,
          -alpha - 1,
          -alpha,
          ply + 1,
          true,
        );
        if (!this._aborted && score > alpha) {
          score = -this._negamax(game, depth - 1, -beta, -alpha, ply + 1, true);
        }
      } else {
        score = -this._negamax(game, depth - 1, -beta, -alpha, ply + 1, true);
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

    // In check → search all legal moves to escape; otherwise only captures/promotions
    const movesToSearch = inCheck
      ? allMoves
      : allMoves.filter(
          (m) => game.board[m.to[0]][m.to[1]] || m.enPassant || m.promotion,
        );

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
    return countMaterial(game.board) < 2600;
  }
}
