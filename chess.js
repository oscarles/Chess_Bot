// ============================================================
//  chess.js  —  Chess engine (rules, move generation, state)
// ============================================================

const PIECES = {
    EMPTY: 0,
    W_PAWN: 1, W_KNIGHT: 2, W_BISHOP: 3, W_ROOK: 4, W_QUEEN: 5, W_KING: 6,
    B_PAWN: 7, B_KNIGHT: 8, B_BISHOP: 9, B_ROOK: 10, B_QUEEN: 11, B_KING: 12,
};

const PIECE_SYMBOLS = {
    [PIECES.W_PAWN]:   '♙', [PIECES.W_KNIGHT]: '♘', [PIECES.W_BISHOP]: '♗',
    [PIECES.W_ROOK]:   '♖', [PIECES.W_QUEEN]:  '♕', [PIECES.W_KING]:   '♔',
    [PIECES.B_PAWN]:   '♟', [PIECES.B_KNIGHT]: '♞', [PIECES.B_BISHOP]: '♝',
    [PIECES.B_ROOK]:   '♜', [PIECES.B_QUEEN]:  '♛', [PIECES.B_KING]:   '♚',
};

const WHITE = 'white';
const BLACK = 'black';

function isWhitePiece(p) { return p >= 1 && p <= 6; }
function isBlackPiece(p) { return p >= 7 && p <= 12; }
function pieceColor(p) {
    if (isWhitePiece(p)) return WHITE;
    if (isBlackPiece(p)) return BLACK;
    return null;
}
function opponent(color) { return color === WHITE ? BLACK : WHITE; }

// Algebraic notation helpers
function squareName(row, col) {
    return String.fromCharCode(97 + col) + (8 - row);
}

function parsePieceName(p) {
    const names = {
        [PIECES.W_PAWN]: 'P', [PIECES.W_KNIGHT]: 'N', [PIECES.W_BISHOP]: 'B',
        [PIECES.W_ROOK]: 'R', [PIECES.W_QUEEN]: 'Q', [PIECES.W_KING]: 'K',
        [PIECES.B_PAWN]: 'P', [PIECES.B_KNIGHT]: 'N', [PIECES.B_BISHOP]: 'B',
        [PIECES.B_ROOK]: 'R', [PIECES.B_QUEEN]: 'Q', [PIECES.B_KING]: 'K',
    };
    return names[p] || '';
}

// ============================================================
//  Evaluation tables — shared with ai.js
//
//  Tables are written from white's perspective:
//      row 0 = rank 8 (top, black's side)
//      row 7 = rank 1 (white's side)
//  For black pieces, the row is mirrored (r = 7 - row) so a
//  single table per piece type serves both colors.
// ============================================================

const PIECE_PHASE = {
    [PIECES.W_PAWN]: 0,   [PIECES.B_PAWN]: 0,
    [PIECES.W_KNIGHT]: 1, [PIECES.B_KNIGHT]: 1,
    [PIECES.W_BISHOP]: 1, [PIECES.B_BISHOP]: 1,
    [PIECES.W_ROOK]: 2,   [PIECES.B_ROOK]: 2,
    [PIECES.W_QUEEN]: 4,  [PIECES.B_QUEEN]: 4,
    [PIECES.W_KING]: 0,   [PIECES.B_KING]: 0,
};
const MAX_PHASE = 24; // 4*1 (knights) + 4*1 (bishops) + 4*2 (rooks) + 2*4 (queens)

// Material values used by the evaluator (king excluded — sentinel handled elsewhere).
const MATERIAL = {
    [PIECES.W_PAWN]: 100,   [PIECES.B_PAWN]: 100,
    [PIECES.W_KNIGHT]: 320, [PIECES.B_KNIGHT]: 320,
    [PIECES.W_BISHOP]: 330, [PIECES.B_BISHOP]: 330,
    [PIECES.W_ROOK]: 500,   [PIECES.B_ROOK]: 500,
    [PIECES.W_QUEEN]: 900,  [PIECES.B_QUEEN]: 900,
    [PIECES.W_KING]: 0,     [PIECES.B_KING]: 0,
};

// --- Middlegame piece-square tables ---
const PST_PAWN_MG = [
    [ 0,  0,  0,  0,  0,  0,  0,  0],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [10, 10, 20, 30, 30, 20, 10, 10],
    [ 5,  5, 10, 25, 25, 10,  5,  5],
    [ 0,  0,  0, 20, 20,  0,  0,  0],
    [ 5, -5,-10,  0,  0,-10, -5,  5],
    [ 5, 10, 10,-20,-20, 10, 10,  5],
    [ 0,  0,  0,  0,  0,  0,  0,  0],
];
const PST_KNIGHT_MG = [
    [-50,-40,-30,-30,-30,-30,-40,-50],
    [-40,-20,  0,  0,  0,  0,-20,-40],
    [-30,  0, 10, 15, 15, 10,  0,-30],
    [-30,  5, 15, 20, 20, 15,  5,-30],
    [-30,  0, 15, 20, 20, 15,  0,-30],
    [-30,  5, 10, 15, 15, 10,  5,-30],
    [-40,-20,  0,  5,  5,  0,-20,-40],
    [-50,-40,-30,-30,-30,-30,-40,-50],
];
const PST_BISHOP_MG = [
    [-20,-10,-10,-10,-10,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5, 10, 10,  5,  0,-10],
    [-10,  5,  5, 10, 10,  5,  5,-10],
    [-10,  0, 10, 10, 10, 10,  0,-10],
    [-10, 10, 10, 10, 10, 10, 10,-10],
    [-10,  5,  0,  0,  0,  0,  5,-10],
    [-20,-10,-10,-10,-10,-10,-10,-20],
];
const PST_ROOK_MG = [
    [ 0,  0,  0,  0,  0,  0,  0,  0],
    [ 5, 10, 10, 10, 10, 10, 10,  5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [ 0,  0,  0,  5,  5,  0,  0,  0],
];
const PST_QUEEN_MG = [
    [-20,-10,-10, -5, -5,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5,  5,  5,  5,  0,-10],
    [ -5,  0,  5,  5,  5,  5,  0, -5],
    [  0,  0,  5,  5,  5,  5,  0, -5],
    [-10,  5,  5,  5,  5,  5,  0,-10],
    [-10,  0,  5,  0,  0,  0,  0,-10],
    [-20,-10,-10, -5, -5,-10,-10,-20],
];
const PST_KING_MG = [
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-20,-30,-30,-40,-40,-30,-30,-20],
    [-10,-20,-20,-20,-20,-20,-20,-10],
    [ 20, 20,  0,  0,  0,  0, 20, 20],
    [ 20, 30, 10,  0,  0, 10, 30, 20],
];

// --- Endgame piece-square tables ---
// Pawns: advancement towards promotion is the dominant factor.
const PST_PAWN_EG = [
    [  0,  0,  0,  0,  0,  0,  0,  0],
    [ 90, 90, 90, 90, 90, 90, 90, 90],
    [ 50, 50, 50, 50, 50, 50, 50, 50],
    [ 30, 30, 30, 30, 30, 30, 30, 30],
    [ 20, 20, 20, 20, 20, 20, 20, 20],
    [ 10, 10, 10, 10, 10, 10, 10, 10],
    [  0,  0,  0,  0,  0,  0,  0,  0],
    [  0,  0,  0,  0,  0,  0,  0,  0],
];
// Minor/heavy pieces: similar centralization in MG and EG.
const PST_KNIGHT_EG = PST_KNIGHT_MG;
const PST_BISHOP_EG = PST_BISHOP_MG;
const PST_ROOK_EG   = PST_ROOK_MG;
const PST_QUEEN_EG  = PST_QUEEN_MG;
// King: active and central in the endgame, hides in MG.
const PST_KING_EG = [
    [-50,-40,-30,-20,-20,-30,-40,-50],
    [-30,-20,-10,  0,  0,-10,-20,-30],
    [-30,-10, 20, 30, 30, 20,-10,-30],
    [-30,-10, 30, 40, 40, 30,-10,-30],
    [-30,-10, 30, 40, 40, 30,-10,-30],
    [-30,-10, 20, 30, 30, 20,-10,-30],
    [-30,-30,  0,  0,  0,  0,-30,-30],
    [-50,-30,-30,-30,-30,-30,-30,-50],
];

// Flat lookups: indexed [piece * 64 + row * 8 + col]. Black rows are pre-mirrored.
const PST_LOOKUP_MG = new Int32Array(13 * 64);
const PST_LOOKUP_EG = new Int32Array(13 * 64);
(function _buildPSTLookups() {
    const mgByPiece = {
        [PIECES.W_PAWN]: PST_PAWN_MG,   [PIECES.B_PAWN]: PST_PAWN_MG,
        [PIECES.W_KNIGHT]: PST_KNIGHT_MG,[PIECES.B_KNIGHT]: PST_KNIGHT_MG,
        [PIECES.W_BISHOP]: PST_BISHOP_MG,[PIECES.B_BISHOP]: PST_BISHOP_MG,
        [PIECES.W_ROOK]: PST_ROOK_MG,   [PIECES.B_ROOK]: PST_ROOK_MG,
        [PIECES.W_QUEEN]: PST_QUEEN_MG, [PIECES.B_QUEEN]: PST_QUEEN_MG,
        [PIECES.W_KING]: PST_KING_MG,   [PIECES.B_KING]: PST_KING_MG,
    };
    const egByPiece = {
        [PIECES.W_PAWN]: PST_PAWN_EG,   [PIECES.B_PAWN]: PST_PAWN_EG,
        [PIECES.W_KNIGHT]: PST_KNIGHT_EG,[PIECES.B_KNIGHT]: PST_KNIGHT_EG,
        [PIECES.W_BISHOP]: PST_BISHOP_EG,[PIECES.B_BISHOP]: PST_BISHOP_EG,
        [PIECES.W_ROOK]: PST_ROOK_EG,   [PIECES.B_ROOK]: PST_ROOK_EG,
        [PIECES.W_QUEEN]: PST_QUEEN_EG, [PIECES.B_QUEEN]: PST_QUEEN_EG,
        [PIECES.W_KING]: PST_KING_EG,   [PIECES.B_KING]: PST_KING_EG,
    };
    for (let p = 1; p <= 12; p++) {
        const isW = (p >= 1 && p <= 6);
        const mgT = mgByPiece[p], egT = egByPiece[p];
        for (let r = 0; r < 8; r++) {
            const tr = isW ? r : 7 - r;
            for (let c = 0; c < 8; c++) {
                PST_LOOKUP_MG[p * 64 + r * 8 + c] = mgT[tr][c];
                PST_LOOKUP_EG[p * 64 + r * 8 + c] = egT[tr][c];
            }
        }
    }
})();

function pstMG(piece, row, col) {
    if (!piece) return 0;
    return PST_LOOKUP_MG[piece * 64 + row * 8 + col];
}
function pstEG(piece, row, col) {
    if (!piece) return 0;
    return PST_LOOKUP_EG[piece * 64 + row * 8 + col];
}

class ChessGame {
    constructor() {
        this.reset();
    }

    reset() {
        this.board = this._initialBoard();
        this.turn = WHITE;
        this.castlingRights = { wK: true, wQ: true, bK: true, bQ: true };
        this.enPassantSquare = null; // [row, col] or null
        this.halfMoveClock = 0;
        this.fullMoveNumber = 1;
        this.history = [];       // array of board states for undo
        this.moveList = [];      // array of {from, to, san, piece, captured}
        this.gameOver = false;
        this.gameResult = null;
        this.capturedByWhite = [];
        this.capturedByBlack = [];
        this._recomputeEvalState();
    }

    _initialBoard() {
        const b = Array.from({length: 8}, () => new Array(8).fill(0));
        // Black pieces (row 0 = rank 8)
        b[0] = [PIECES.B_ROOK, PIECES.B_KNIGHT, PIECES.B_BISHOP, PIECES.B_QUEEN,
                PIECES.B_KING, PIECES.B_BISHOP, PIECES.B_KNIGHT, PIECES.B_ROOK];
        b[1].fill(PIECES.B_PAWN);
        // White pieces (row 7 = rank 1)
        b[6].fill(PIECES.W_PAWN);
        b[7] = [PIECES.W_ROOK, PIECES.W_KNIGHT, PIECES.W_BISHOP, PIECES.W_QUEEN,
                PIECES.W_KING, PIECES.W_BISHOP, PIECES.W_KNIGHT, PIECES.W_ROOK];
        return b;
    }

    // Deep-copy game state for undo / AI
    cloneState() {
        return {
            board: this.board.map(r => [...r]),
            turn: this.turn,
            castlingRights: {...this.castlingRights},
            enPassantSquare: this.enPassantSquare ? [...this.enPassantSquare] : null,
            halfMoveClock: this.halfMoveClock,
            fullMoveNumber: this.fullMoveNumber,
            psqt_mg: this.psqt_mg,
            psqt_eg: this.psqt_eg,
            material: this.material,
            phase: this.phase,
        };
    }

    restoreState(state) {
        this.board = state.board.map(r => [...r]);
        this.turn = state.turn;
        this.castlingRights = {...state.castlingRights};
        this.enPassantSquare = state.enPassantSquare ? [...state.enPassantSquare] : null;
        this.halfMoveClock = state.halfMoveClock;
        this.fullMoveNumber = state.fullMoveNumber;
        this.psqt_mg = state.psqt_mg;
        this.psqt_eg = state.psqt_eg;
        this.material = state.material;
        this.phase = state.phase;
    }

    // Full-board scan that recomputes the incremental eval fields.
    // Called on reset/loadFEN, and as a safety net at the start of a search.
    _recomputeEvalState() {
        let psqt_mg = 0, psqt_eg = 0, material = 0, phase = 0;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const p = this.board[r][c];
                if (!p) continue;
                const sign = isWhitePiece(p) ? 1 : -1;
                psqt_mg += sign * pstMG(p, r, c);
                psqt_eg += sign * pstEG(p, r, c);
                material += sign * MATERIAL[p];
                phase += PIECE_PHASE[p];
            }
        }
        this.psqt_mg = psqt_mg;
        this.psqt_eg = psqt_eg;
        this.material = material;
        this.phase = phase;
    }

    // -------------------------------------------------------
    //  Move generation
    // -------------------------------------------------------

    getLegalMoves(color) {
        const pseudo = this._getPseudoMoves(color);
        return pseudo.filter(mv => !this._moveLeavesKingInCheck(mv, color));
    }

    getLegalMovesFrom(row, col) {
        const piece = this.board[row][col];
        if (!piece || pieceColor(piece) !== this.turn) return [];
        const pseudo = this._getPseudoMovesFrom(row, col, piece, this.turn);
        return pseudo.filter(mv => !this._moveLeavesKingInCheck(mv, this.turn));
    }

    _getPseudoMoves(color) {
        const moves = [];
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const p = this.board[r][c];
                if (p && pieceColor(p) === color) {
                    moves.push(...this._getPseudoMovesFrom(r, c, p, color));
                }
            }
        }
        return moves;
    }

    _getPseudoMovesFrom(row, col, piece, color) {
        const moves = [];
        const opp = opponent(color);

        const addMove = (tr, tc, flags = {}) => {
            if (tr < 0 || tr > 7 || tc < 0 || tc > 7) return;
            moves.push({ from: [row, col], to: [tr, tc], ...flags });
        };

        const addSlide = (dr, dc) => {
            let r = row + dr, c = col + dc;
            while (r >= 0 && r < 8 && c >= 0 && c < 8) {
                const target = this.board[r][c];
                if (!target) { addMove(r, c); }
                else {
                    if (pieceColor(target) === opp) addMove(r, c);
                    break;
                }
                r += dr; c += dc;
            }
        };

        switch (piece) {
            case PIECES.W_PAWN: {
                // Forward 1
                if (row > 0 && !this.board[row-1][col]) {
                    if (row - 1 === 0) {
                        for (const promo of [PIECES.W_QUEEN, PIECES.W_ROOK, PIECES.W_BISHOP, PIECES.W_KNIGHT])
                            addMove(row-1, col, { promotion: promo });
                    } else {
                        addMove(row-1, col);
                        // Forward 2 from start
                        if (row === 6 && !this.board[row-2][col]) addMove(row-2, col);
                    }
                }
                // Captures
                for (const dc of [-1, 1]) {
                    const tc = col + dc, tr = row - 1;
                    if (tc < 0 || tc > 7 || tr < 0) continue;
                    if (isBlackPiece(this.board[tr][tc])) {
                        if (tr === 0) {
                            for (const promo of [PIECES.W_QUEEN, PIECES.W_ROOK, PIECES.W_BISHOP, PIECES.W_KNIGHT])
                                addMove(tr, tc, { promotion: promo });
                        } else addMove(tr, tc);
                    }
                    // En passant
                    if (this.enPassantSquare && tr === this.enPassantSquare[0] && tc === this.enPassantSquare[1]) {
                        addMove(tr, tc, { enPassant: true });
                    }
                }
                break;
            }
            case PIECES.B_PAWN: {
                if (row < 7 && !this.board[row+1][col]) {
                    if (row + 1 === 7) {
                        for (const promo of [PIECES.B_QUEEN, PIECES.B_ROOK, PIECES.B_BISHOP, PIECES.B_KNIGHT])
                            addMove(row+1, col, { promotion: promo });
                    } else {
                        addMove(row+1, col);
                        if (row === 1 && !this.board[row+2][col]) addMove(row+2, col);
                    }
                }
                for (const dc of [-1, 1]) {
                    const tc = col + dc, tr = row + 1;
                    if (tc < 0 || tc > 7 || tr > 7) continue;
                    if (isWhitePiece(this.board[tr][tc])) {
                        if (tr === 7) {
                            for (const promo of [PIECES.B_QUEEN, PIECES.B_ROOK, PIECES.B_BISHOP, PIECES.B_KNIGHT])
                                addMove(tr, tc, { promotion: promo });
                        } else addMove(tr, tc);
                    }
                    if (this.enPassantSquare && tr === this.enPassantSquare[0] && tc === this.enPassantSquare[1]) {
                        addMove(tr, tc, { enPassant: true });
                    }
                }
                break;
            }
            case PIECES.W_KNIGHT: case PIECES.B_KNIGHT: {
                for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
                    const tr = row+dr, tc = col+dc;
                    if (tr<0||tr>7||tc<0||tc>7) continue;
                    const target = this.board[tr][tc];
                    if (!target || pieceColor(target) === opp) addMove(tr, tc);
                }
                break;
            }
            case PIECES.W_BISHOP: case PIECES.B_BISHOP: {
                for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) addSlide(dr, dc);
                break;
            }
            case PIECES.W_ROOK: case PIECES.B_ROOK: {
                for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) addSlide(dr, dc);
                break;
            }
            case PIECES.W_QUEEN: case PIECES.B_QUEEN: {
                for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]) addSlide(dr, dc);
                break;
            }
            case PIECES.W_KING: {
                for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
                    const tr = row+dr, tc = col+dc;
                    if (tr<0||tr>7||tc<0||tc>7) continue;
                    const target = this.board[tr][tc];
                    if (!target || isBlackPiece(target)) addMove(tr, tc);
                }
                // Castling
                if (this.castlingRights.wK && row===7 && col===4 &&
                    !this.board[7][5] && !this.board[7][6] &&
                    this.board[7][7]===PIECES.W_ROOK &&
                    !this._isSquareAttacked(7,4,BLACK) && !this._isSquareAttacked(7,5,BLACK) && !this._isSquareAttacked(7,6,BLACK)) {
                    addMove(7, 6, { castle: 'K' });
                }
                if (this.castlingRights.wQ && row===7 && col===4 &&
                    !this.board[7][3] && !this.board[7][2] && !this.board[7][1] &&
                    this.board[7][0]===PIECES.W_ROOK &&
                    !this._isSquareAttacked(7,4,BLACK) && !this._isSquareAttacked(7,3,BLACK) && !this._isSquareAttacked(7,2,BLACK)) {
                    addMove(7, 2, { castle: 'Q' });
                }
                break;
            }
            case PIECES.B_KING: {
                for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
                    const tr = row+dr, tc = col+dc;
                    if (tr<0||tr>7||tc<0||tc>7) continue;
                    const target = this.board[tr][tc];
                    if (!target || isWhitePiece(target)) addMove(tr, tc);
                }
                if (this.castlingRights.bK && row===0 && col===4 &&
                    !this.board[0][5] && !this.board[0][6] &&
                    this.board[0][7]===PIECES.B_ROOK &&
                    !this._isSquareAttacked(0,4,WHITE) && !this._isSquareAttacked(0,5,WHITE) && !this._isSquareAttacked(0,6,WHITE)) {
                    addMove(0, 6, { castle: 'K' });
                }
                if (this.castlingRights.bQ && row===0 && col===4 &&
                    !this.board[0][3] && !this.board[0][2] && !this.board[0][1] &&
                    this.board[0][0]===PIECES.B_ROOK &&
                    !this._isSquareAttacked(0,4,WHITE) && !this._isSquareAttacked(0,3,WHITE) && !this._isSquareAttacked(0,2,WHITE)) {
                    addMove(0, 2, { castle: 'Q' });
                }
                break;
            }
        }
        return moves;
    }

    // Check if a square is attacked by 'attackingColor'
    _isSquareAttacked(row, col, attackingColor) {
        const opp = attackingColor;
        // Check pawn attacks
        if (opp === WHITE) {
            for (const dc of [-1, 1]) {
                const r = row + 1, c = col + dc;
                if (r >= 0 && r < 8 && c >= 0 && c < 8 && this.board[r][c] === PIECES.W_PAWN) return true;
            }
        } else {
            for (const dc of [-1, 1]) {
                const r = row - 1, c = col + dc;
                if (r >= 0 && r < 8 && c >= 0 && c < 8 && this.board[r][c] === PIECES.B_PAWN) return true;
            }
        }
        // Knight attacks
        const knight = opp === WHITE ? PIECES.W_KNIGHT : PIECES.B_KNIGHT;
        for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
            const r = row+dr, c = col+dc;
            if (r>=0&&r<8&&c>=0&&c<8&&this.board[r][c]===knight) return true;
        }
        // Sliding pieces
        const bishop = opp === WHITE ? PIECES.W_BISHOP : PIECES.B_BISHOP;
        const rook   = opp === WHITE ? PIECES.W_ROOK   : PIECES.B_ROOK;
        const queen  = opp === WHITE ? PIECES.W_QUEEN  : PIECES.B_QUEEN;
        const king   = opp === WHITE ? PIECES.W_KING   : PIECES.B_KING;

        for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
            let r = row+dr, c = col+dc;
            while (r>=0&&r<8&&c>=0&&c<8) {
                const p = this.board[r][c];
                if (p) {
                    if (p===bishop||p===queen) return true;
                    break;
                }
                r+=dr; c+=dc;
            }
        }
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            let r = row+dr, c = col+dc;
            while (r>=0&&r<8&&c>=0&&c<8) {
                const p = this.board[r][c];
                if (p) {
                    if (p===rook||p===queen) return true;
                    break;
                }
                r+=dr; c+=dc;
            }
        }
        // King
        for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
            const r = row+dr, c = col+dc;
            if (r>=0&&r<8&&c>=0&&c<8&&this.board[r][c]===king) return true;
        }
        return false;
    }

    _findKing(color) {
        const king = color === WHITE ? PIECES.W_KING : PIECES.B_KING;
        for (let r = 0; r < 8; r++)
            for (let c = 0; c < 8; c++)
                if (this.board[r][c] === king) return [r, c];
        return null;
    }

    isInCheck(color) {
        const pos = this._findKing(color);
        if (!pos) return false;
        return this._isSquareAttacked(pos[0], pos[1], opponent(color));
    }

    _moveLeavesKingInCheck(move, color) {
        const saved = this.cloneState();
        this._applyMoveNoHistory(move);
        const inCheck = this.isInCheck(color);
        this.restoreState(saved);
        return inCheck;
    }

    // -------------------------------------------------------
    //  Apply moves
    // -------------------------------------------------------

    _applyMoveNoHistory(move) {
        const [fr, fc] = move.from;
        const [tr, tc] = move.to;
        const piece = this.board[fr][fc];
        const color = pieceColor(piece);
        const sign = isWhitePiece(piece) ? 1 : -1;

        this.enPassantSquare = null;

        // Eval: remove the moving piece from its source square
        this.psqt_mg -= sign * pstMG(piece, fr, fc);
        this.psqt_eg -= sign * pstEG(piece, fr, fc);

        // En passant capture — captured pawn sits on an adjacent square, not the destination
        if (move.enPassant) {
            const captureRow = color === WHITE ? tr + 1 : tr - 1;
            const cap = this.board[captureRow][tc];
            if (cap) {
                const csign = isWhitePiece(cap) ? 1 : -1;
                this.psqt_mg -= csign * pstMG(cap, captureRow, tc);
                this.psqt_eg -= csign * pstEG(cap, captureRow, tc);
                this.material -= csign * MATERIAL[cap];
                // Captured pawn carries no phase weight, so no phase update.
            }
            this.board[captureRow][tc] = PIECES.EMPTY;
        }

        // Regular capture at the destination square
        const target = this.board[tr][tc];
        if (target) {
            const tsign = isWhitePiece(target) ? 1 : -1;
            this.psqt_mg -= tsign * pstMG(target, tr, tc);
            this.psqt_eg -= tsign * pstEG(target, tr, tc);
            this.material -= tsign * MATERIAL[target];
            this.phase -= PIECE_PHASE[target];
        }

        // Castling: also move the rook, and update its PST contribution
        if (move.castle) {
            let rook, rfr, rfc, rtr, rtc;
            if (piece === PIECES.W_KING) {
                rook = PIECES.W_ROOK;
                if (move.castle === 'K') { rfr=7; rfc=7; rtr=7; rtc=5; }
                else                     { rfr=7; rfc=0; rtr=7; rtc=3; }
                this.castlingRights.wK = false; this.castlingRights.wQ = false;
            } else {
                rook = PIECES.B_ROOK;
                if (move.castle === 'K') { rfr=0; rfc=7; rtr=0; rtc=5; }
                else                     { rfr=0; rfc=0; rtr=0; rtc=3; }
                this.castlingRights.bK = false; this.castlingRights.bQ = false;
            }
            const rsign = isWhitePiece(rook) ? 1 : -1;
            this.psqt_mg += rsign * (pstMG(rook, rtr, rtc) - pstMG(rook, rfr, rfc));
            this.psqt_eg += rsign * (pstEG(rook, rtr, rtc) - pstEG(rook, rfr, rfc));
            this.board[rfr][rfc] = 0;
            this.board[rtr][rtc] = rook;
        }

        // Update castling rights on rook/king moves
        if (piece === PIECES.W_KING) { this.castlingRights.wK = false; this.castlingRights.wQ = false; }
        if (piece === PIECES.B_KING) { this.castlingRights.bK = false; this.castlingRights.bQ = false; }
        if (piece === PIECES.W_ROOK) {
            if (fr===7&&fc===7) this.castlingRights.wK = false;
            if (fr===7&&fc===0) this.castlingRights.wQ = false;
        }
        if (piece === PIECES.B_ROOK) {
            if (fr===0&&fc===7) this.castlingRights.bK = false;
            if (fr===0&&fc===0) this.castlingRights.bQ = false;
        }

        // En passant opportunity
        if ((piece === PIECES.W_PAWN && fr-tr === 2) || (piece === PIECES.B_PAWN && tr-fr === 2)) {
            this.enPassantSquare = [(fr + tr) / 2, fc];
        }

        // Promotion adjusts material and phase before we place the new piece.
        const newPiece = move.promotion || piece;
        if (move.promotion) {
            this.material += sign * (MATERIAL[newPiece] - MATERIAL[piece]);
            this.phase += PIECE_PHASE[newPiece] - PIECE_PHASE[piece];
        }

        // Eval: add the moved (or promoted) piece at the destination
        this.psqt_mg += sign * pstMG(newPiece, tr, tc);
        this.psqt_eg += sign * pstEG(newPiece, tr, tc);

        this.board[tr][tc] = newPiece;
        this.board[fr][fc] = PIECES.EMPTY;

        this.turn = opponent(this.turn);
    }

    makeMove(move, promotionPiece = null) {
        const [fr, fc] = move.from;
        const [tr, tc] = move.to;
        const piece = this.board[fr][fc];
        const captured = this.board[tr][tc];

        // Save state for undo
        this.history.push(this.cloneState());

        // Determine SAN before applying
        const san = this._toSAN(move, piece, captured);

        // Track captures
        if (captured) {
            if (pieceColor(captured) === WHITE) this.capturedByBlack.push(captured);
            else this.capturedByWhite.push(captured);
        }
        if (move.enPassant) {
            const epCap = this.turn === WHITE ? PIECES.B_PAWN : PIECES.W_PAWN;
            if (this.turn === WHITE) this.capturedByWhite.push(epCap);
            else this.capturedByBlack.push(epCap);
        }

        this._applyMoveNoHistory(move);

        // Check / checkmate annotation
        const oppColor = this.turn; // already switched
        const oppMoves = this.getLegalMoves(oppColor);
        let annotation = '';
        if (this.isInCheck(oppColor)) {
            annotation = oppMoves.length === 0 ? '#' : '+';
        }

        this.moveList.push({
            from: [fr, fc],
            to: [tr, tc],
            san: san + annotation,
            piece,
            captured,
            move,
        });

        if (this.turn === WHITE) this.fullMoveNumber++;

        // Game-over detection
        if (oppMoves.length === 0) {
            this.gameOver = true;
            if (this.isInCheck(oppColor)) {
                this.gameResult = { winner: opponent(oppColor), reason: 'checkmate' };
            } else {
                this.gameResult = { winner: null, reason: 'stalemate' };
            }
        } else if (this.halfMoveClock >= 100) {
            this.gameOver = true;
            this.gameResult = { winner: null, reason: '50-move rule' };
        } else if (this._isInsufficientMaterial()) {
            this.gameOver = true;
            this.gameResult = { winner: null, reason: 'insufficient material' };
        }

        return { san: san + annotation, captured };
    }

    undoMove() {
        if (this.history.length === 0) return false;
        const state = this.history.pop();
        this.restoreState(state);
        this.moveList.pop();
        this.gameOver = false;
        this.gameResult = null;
        // Rebuild captures from moveList
        this.capturedByWhite = [];
        this.capturedByBlack = [];
        for (const mv of this.moveList) {
            if (mv.captured) {
                if (pieceColor(mv.captured) === WHITE) this.capturedByBlack.push(mv.captured);
                else this.capturedByWhite.push(mv.captured);
            }
        }
        return true;
    }

    _toSAN(move, piece, captured) {
        const [fr, fc] = move.from;
        const [tr, tc] = move.to;

        if (move.castle) return move.castle === 'K' ? 'O-O' : 'O-O-O';

        const pieceName = parsePieceName(piece);
        const destName = squareName(tr, tc);
        const isPawn = (piece === PIECES.W_PAWN || piece === PIECES.B_PAWN);

        let san = '';
        if (isPawn) {
            if (captured || move.enPassant) san = String.fromCharCode(97 + fc) + 'x' + destName;
            else san = destName;
            if (move.promotion) san += '=' + parsePieceName(move.promotion);
        } else {
            san = pieceName;
            // Disambiguation (simplified)
            const ambiguous = this._getPseudoMoves(pieceColor(piece))
                .filter(m => !m.castle && this.board[m.from[0]][m.from[1]] === piece &&
                    m.to[0] === tr && m.to[1] === tc &&
                    !(m.from[0] === fr && m.from[1] === fc));
            if (ambiguous.length > 0) {
                if (ambiguous.every(m => m.from[1] !== fc)) san += String.fromCharCode(97 + fc);
                else if (ambiguous.every(m => m.from[0] !== fr)) san += (8 - fr);
                else san += squareName(fr, fc);
            }
            if (captured) san += 'x';
            san += destName;
        }
        return san;
    }

    _isInsufficientMaterial() {
        const pieces = [];
        for (let r = 0; r < 8; r++)
            for (let c = 0; c < 8; c++)
                if (this.board[r][c]) pieces.push(this.board[r][c]);
        if (pieces.length === 2) return true; // K vs K
        if (pieces.length === 3) {
            const minor = [PIECES.W_BISHOP, PIECES.B_BISHOP, PIECES.W_KNIGHT, PIECES.B_KNIGHT];
            if (pieces.some(p => minor.includes(p))) return true;
        }
        return false;
    }

    loadFEN(fen) {
        const parts = fen.trim().split(/\s+/);
        const rows = parts[0].split('/');
        if (rows.length !== 8) throw new Error('FEN invalide : 8 rangées attendues');

        const FEN_PIECES = {
            'P': PIECES.W_PAWN,   'N': PIECES.W_KNIGHT, 'B': PIECES.W_BISHOP,
            'R': PIECES.W_ROOK,   'Q': PIECES.W_QUEEN,  'K': PIECES.W_KING,
            'p': PIECES.B_PAWN,   'n': PIECES.B_KNIGHT, 'b': PIECES.B_BISHOP,
            'r': PIECES.B_ROOK,   'q': PIECES.B_QUEEN,  'k': PIECES.B_KING,
        };

        this.board = Array.from({length: 8}, () => new Array(8).fill(0));
        for (let r = 0; r < 8; r++) {
            let c = 0;
            for (const ch of rows[r]) {
                if (ch >= '1' && ch <= '8') {
                    c += parseInt(ch);
                } else {
                    if (!(ch in FEN_PIECES)) throw new Error(`Pièce FEN inconnue : '${ch}'`);
                    this.board[r][c] = FEN_PIECES[ch];
                    c++;
                }
            }
            if (c !== 8) throw new Error(`FEN invalide : rangée ${8 - r} malformée`);
        }

        this.turn = (parts[1] === 'b') ? BLACK : WHITE;

        this.castlingRights = { wK: false, wQ: false, bK: false, bQ: false };
        if (parts[2] && parts[2] !== '-') {
            if (parts[2].includes('K')) this.castlingRights.wK = true;
            if (parts[2].includes('Q')) this.castlingRights.wQ = true;
            if (parts[2].includes('k')) this.castlingRights.bK = true;
            if (parts[2].includes('q')) this.castlingRights.bQ = true;
        }

        this.enPassantSquare = null;
        if (parts[3] && parts[3] !== '-') {
            const col = parts[3].charCodeAt(0) - 97;
            const row = 8 - parseInt(parts[3][1]);
            this.enPassantSquare = [row, col];
        }

        this.halfMoveClock  = parts[4] ? parseInt(parts[4]) : 0;
        this.fullMoveNumber = parts[5] ? parseInt(parts[5]) : 1;

        this.history = [];
        this.moveList = [];
        this.gameOver = false;
        this.gameResult = null;
        this.capturedByWhite = [];
        this.capturedByBlack = [];
        this._recomputeEvalState();
    }

    generatePGN(options = {}) {
        const {
            whiteName = 'Blancs',
            blackName = 'Noirs',
            event = 'Chess Bot',
            site = '?',
        } = options;

        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '.');

        let result = '*';
        if (this.gameResult) {
            if (this.gameResult.winner === WHITE) result = '1-0';
            else if (this.gameResult.winner === BLACK) result = '0-1';
            else result = '1/2-1/2';
        }

        const headers = [
            `[Event "${event}"]`,
            `[Site "${site}"]`,
            `[Date "${date}"]`,
            `[Round "?"]`,
            `[White "${whiteName}"]`,
            `[Black "${blackName}"]`,
            `[Result "${result}"]`,
        ].join('\n');

        let movesText = '';
        for (let i = 0; i < this.moveList.length; i++) {
            if (i % 2 === 0) movesText += `${Math.floor(i / 2) + 1}. `;
            movesText += this.moveList[i].san + ' ';
        }
        movesText += result;

        return headers + '\n\n' + movesText.trim();
    }
}
