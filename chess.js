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
        };
    }

    restoreState(state) {
        this.board = state.board.map(r => [...r]);
        this.turn = state.turn;
        this.castlingRights = {...state.castlingRights};
        this.enPassantSquare = state.enPassantSquare ? [...state.enPassantSquare] : null;
        this.halfMoveClock = state.halfMoveClock;
        this.fullMoveNumber = state.fullMoveNumber;
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

        this.enPassantSquare = null;

        // En passant capture
        if (move.enPassant) {
            const captureRow = color === WHITE ? tr + 1 : tr - 1;
            this.board[captureRow][tc] = PIECES.EMPTY;
        }

        // Castling: also move rook
        if (move.castle) {
            if (piece === PIECES.W_KING) {
                if (move.castle === 'K') { this.board[7][7] = 0; this.board[7][5] = PIECES.W_ROOK; }
                else                     { this.board[7][0] = 0; this.board[7][3] = PIECES.W_ROOK; }
                this.castlingRights.wK = false; this.castlingRights.wQ = false;
            } else {
                if (move.castle === 'K') { this.board[0][7] = 0; this.board[0][5] = PIECES.B_ROOK; }
                else                     { this.board[0][0] = 0; this.board[0][3] = PIECES.B_ROOK; }
                this.castlingRights.bK = false; this.castlingRights.bQ = false;
            }
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

        // Move piece
        this.board[tr][tc] = move.promotion || piece;
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
