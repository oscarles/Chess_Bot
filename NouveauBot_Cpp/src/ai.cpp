#include "ai.h"
#include <algorithm>
#include <cstring>
#include <sstream>
#include <unordered_map>
#include <vector>
#include <random>

// ─── Table de transposition ───────────────────────────────────────────────────
void TTable::store(U64 h, int d, int sc, TTFlag fl, Move m) {
    TTEntry& e = entries[h & (TT_SIZE - 1)];
    if (e.hash != h || e.depth <= d) {
        e.hash  = h;
        e.score = sc;
        e.depth = (int8_t)d;
        e.flag  = fl;
        e.from  = (uint8_t)m.from;
        e.to    = (uint8_t)m.to;
        e.promo = m.promo;
    }
}

bool TTable::probe(U64 h, int d, int alpha, int beta, int& score, Move& m) const {
    const TTEntry& e = entries[h & (TT_SIZE - 1)];
    if (e.hash != h) return false;
    m.from  = e.from; m.to = e.to; m.promo = e.promo;
    m.piece = W_PAWN;
    if (e.depth < d) return false;
    int sc = e.score;
    if (e.flag == TT_EXACT)               { score = sc; return true; }
    if (e.flag == TT_LOWER && sc >= beta)  { score = sc; return true; }
    if (e.flag == TT_UPPER && sc <= alpha) { score = sc; return true; }
    return false;
}

Move TTable::bestMove(U64 h) const {
    const TTEntry& e = entries[h & (TT_SIZE - 1)];
    if (e.hash != h) return Move::null();
    Move m; m.from = e.from; m.to = e.to; m.promo = e.promo;
    return m;
}

// ─── Valeurs de pièces ────────────────────────────────────────────────────────
static const int PIECE_VAL[13] = {100,320,330,500,900,20000,100,320,330,500,900,20000,0};

static bool isEndgame(const Position& pos) {
    int queens = popcnt(pos.bb[W_QUEEN]) + popcnt(pos.bb[B_QUEEN]);
    int minors = popcnt(pos.bb[W_KNIGHT])+ popcnt(pos.bb[B_KNIGHT])
               + popcnt(pos.bb[W_BISHOP])+ popcnt(pos.bb[B_BISHOP]);
    int rooks  = popcnt(pos.bb[W_ROOK])  + popcnt(pos.bb[B_ROOK]);
    return queens == 0 || (queens == 2 && minors + rooks <= 2);
}

// ─── SEE (Static Exchange Evaluation) ────────────────────────────────────────
static int see(const Position& pos, Move m) {
    if (m.enPassant) return 100;
    int toSq = m.to;
    Piece victim = (Piece)pos.bd[toSq];
    if (victim == EMPTY) return 0;

    int gain[32]; int d = 0;
    gain[0] = PIECE_VAL[(int)victim];

    // Copie locale pour simuler les prises
    U64 occ = pos.occ;
    U64 lbb[12]; memcpy(lbb, pos.bb, 12*sizeof(U64));

    // Retirer l'attaquant initial
    occ ^= (1ULL << m.from);
    lbb[(int)m.piece] ^= (1ULL << m.from);

    Color stm = (colorOf(m.piece) == WHITE) ? BLACK : WHITE;
    int attVal = PIECE_VAL[(int)m.piece];

    while (true) {
        d++;
        gain[d] = attVal - gain[d-1];
        if (std::max(-gain[d-1], gain[d]) < 0) break;

        // Chercher le LVA pour stm vers toSq
        U64 lva = 0ULL; int lvaP = -1;

        // Pions
        {
            // PAWN_ATK[color][sq] = cases attaquées depuis sq par un pion de color
            // Pour trouver les pions de stm qui attaquent toSq :
            // un pion blanc attaque toSq si toSq est dans PAWN_ATK[WHITE][sq]
            // ⟺ sq est dans PAWN_ATK[BLACK][toSq]
            Color opp = (Color)(stm ^ 1);
            U64 pAtk = PAWN_ATK[(int)opp][toSq] & lbb[(int)mkPiece(stm,PAWN)] & occ;
            if (pAtk) { lva = pAtk & -pAtk; lvaP = (int)mkPiece(stm,PAWN); }
        }
        if (!lva) {
            U64 nAtk = KNIGHT_ATK[toSq] & lbb[(int)mkPiece(stm,KNIGHT)] & occ;
            if (nAtk) { lva = nAtk & -nAtk; lvaP = (int)mkPiece(stm,KNIGHT); }
        }
        if (!lva) {
            U64 bAtk = bishopAttacks(toSq, occ) & lbb[(int)mkPiece(stm,BISHOP)];
            if (bAtk) { lva = bAtk & -bAtk; lvaP = (int)mkPiece(stm,BISHOP); }
        }
        if (!lva) {
            U64 rAtk = rookAttacks(toSq, occ) & lbb[(int)mkPiece(stm,ROOK)];
            if (rAtk) { lva = rAtk & -rAtk; lvaP = (int)mkPiece(stm,ROOK); }
        }
        if (!lva) {
            U64 qAtk = (bishopAttacks(toSq,occ)|rookAttacks(toSq,occ)) & lbb[(int)mkPiece(stm,QUEEN)];
            if (qAtk) { lva = qAtk & -qAtk; lvaP = (int)mkPiece(stm,QUEEN); }
        }
        if (!lva) {
            U64 kAtk = KING_ATK[toSq] & lbb[(int)mkPiece(stm,KING)] & occ;
            if (kAtk) { lva = kAtk & -kAtk; lvaP = (int)mkPiece(stm,KING); }
        }
        if (!lva || lvaP < 0) break;

        occ    ^= lva;
        lbb[lvaP] ^= lva;
        attVal  = PIECE_VAL[lvaP];
        stm     = (Color)(stm ^ 1);
        if (d >= 31) break;
    }

    while (d > 0) {
        gain[d-1] = -std::max(-gain[d-1], gain[d]);
        d--;
    }
    return gain[0];
}

// ─── Ordre des coups ──────────────────────────────────────────────────────────
int ChessAI::scoreMove(const Position& pos, Move m, Move ttMove, int ply) const {
    if (ttMove.valid() && movesEq(m, ttMove)) return 2'000'000;
    if (m.captured != EMPTY || m.enPassant) {
        int s = see(pos, m);
        return s >= 0 ? 1'000'000 + s : -500'000 + s;
    }
    if (m.promo != EMPTY) return 900'000 + PIECE_VAL[(int)m.promo];
    if (movesEq(m, killers[ply][0])) return 700'000;
    if (movesEq(m, killers[ply][1])) return 600'000;
    return history[(int)m.piece][(int)m.to];
}

static void sortMoves(std::vector<Move>& moves, const Position& pos,
                      Move ttMove, const Move killers[][2],
                      const int history[][64], int ply)
{
    int n = (int)moves.size();
    std::vector<int> scores(n);
    for (int i = 0; i < n; i++) {
        Move& mv = moves[i];
        if (ttMove.valid() && movesEq(mv, ttMove)) { scores[i]=2'000'000; continue; }
        if (mv.captured != EMPTY || mv.enPassant) {
            int s = see(pos, mv);
            scores[i] = s >= 0 ? 1'000'000 + s : -500'000 + s;
            continue;
        }
        if (mv.promo != EMPTY) { scores[i]=900'000+PIECE_VAL[(int)mv.promo]; continue; }
        if (movesEq(mv, killers[ply][0])) { scores[i]=700'000; continue; }
        if (movesEq(mv, killers[ply][1])) { scores[i]=600'000; continue; }
        scores[i] = history[(int)mv.piece][(int)mv.to];
    }
    for (int i = 1; i < n; i++) {
        Move  tm = moves[i]; int ts = scores[i]; int j = i-1;
        while (j >= 0 && scores[j] < ts) { moves[j+1]=moves[j]; scores[j+1]=scores[j]; j--; }
        moves[j+1]=tm; scores[j+1]=ts;
    }
}

// ─── Livre d'ouverture ────────────────────────────────────────────────────────
static std::unordered_map<U64, std::vector<Move>> BOOK;
static bool bookBuilt = false;

static void buildBook() {
    static const char* LINES[] = {
        // 1.e4 e5
        "e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3",
        "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3",
        "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1",
        "e2e4 e7e5 g1f3 b8c6 f1b5 g8f6",
        "e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4",
        "e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4",
        "e2e4 e7e5 b1c3 g8f6 f1c4 f8c5",
        // Sicilienne
        "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3",
        "e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3",
        "e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4 a7a6",
        "e2e4 c7c5 b1c3 b8c6 g1f3 g7g6",
        // Française
        "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6",
        "e2e4 e7e6 d2d4 d7d5 e4e5 c7c5 c2c3",
        // Caro-Kann
        "e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 g8f6 e4f6",
        "e2e4 c7c6 d2d4 d7d5 e4d5 c6d5 c2c4",
        // Scandinavian
        "e2e4 d7d5 e4d5 d8d5 b1c3 d5a5",
        // 1.d4
        "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 g1f3 f8e7 c1f4",
        "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 e7e6",
        "d2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6",
        "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3",
        "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3",
        "d2d4 g8f6 c2c4 e7e6 g1f3 b7b6 g2g3",
        "d2d4 f7f5 g2g3 g8f6 f1g2 e7e6 g1f3",
        // Anglaise
        "c2c4 e7e5 b1c3 g8f6 g1f3 b8c6",
        "c2c4 g8f6 b1c3 e7e6 e2e4 d7d5",
        "c2c4 c7c5 g1f3 g8f6 b1c3 e7e6",
        // Réti
        "g1f3 d7d5 c2c4 d5d4 e2e3",
        "g1f3 g8f6 c2c4 e7e6 b1c3 d7d5",
        nullptr
    };

    Position pos;
    for (int li = 0; LINES[li]; li++) {
        pos.fromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        std::istringstream ss(LINES[li]);
        std::string tok;
        while (ss >> tok) {
            if (tok.size() < 4) break;
            int ff = tok[0]-'a', fr = tok[1]-'1';
            int tf = tok[2]-'a', tr = tok[3]-'1';
            int fromSq = fr*8+ff, toSq = tr*8+tf;
            Piece promo = EMPTY;
            if (tok.size() >= 5) {
                Color c = pos.side();
                switch(tok[4]) {
                    case 'q': promo=mkPiece(c,QUEEN);  break;
                    case 'r': promo=mkPiece(c,ROOK);   break;
                    case 'b': promo=mkPiece(c,BISHOP); break;
                    case 'n': promo=mkPiece(c,KNIGHT); break;
                }
            }
            auto legal = pos.genMoves();
            Move bm = Move::null();
            for (auto& lm : legal) {
                if (lm.from==fromSq && lm.to==toSq && lm.promo==promo) { bm=lm; break; }
            }
            if (!bm.valid()) break;

            // Stocker le coup du livre pour cette position (si pas déjà présent)
            U64 key = pos.zobrist;
            auto& vec = BOOK[key];
            bool found = false;
            for (auto& em : vec) if (movesEq(em, bm)) { found=true; break; }
            if (!found) vec.push_back(bm);

            UndoInfo u = pos.doMove(bm); (void)u;
        }
    }
    bookBuilt = true;
}

static Move probeBook(const Position& pos) {
    auto it = BOOK.find(pos.zobrist);
    if (it == BOOK.end() || it->second.empty()) return Move::null();
    // Vérifier que les coups sont légaux
    auto legal = pos.genMoves();
    std::vector<Move> valid;
    for (auto& bm : it->second) {
        for (auto& lm : legal)
            if (lm.from==bm.from && lm.to==bm.to && lm.promo==bm.promo) { valid.push_back(lm); break; }
    }
    if (valid.empty()) return Move::null();
    // Tirage aléatoire parmi les coups valides
    static std::mt19937 rng(42);
    std::uniform_int_distribution<int> dist(0,(int)valid.size()-1);
    return valid[dist(rng)];
}

// ─── Recherche principale ─────────────────────────────────────────────────────
bool ChessAI::timeUp() const {
    auto now = std::chrono::steady_clock::now();
    return std::chrono::duration_cast<std::chrono::milliseconds>(now - startTime).count()
           >= timeLimit;
}

void ChessAI::resetSearchState() {
    memset(killers, 0, sizeof(killers));
    memset(history, 0, sizeof(history));
}

int ChessAI::qsearch(Position& pos, int alpha, int beta, int ply) {
    nodes++;
    if (aborted) return 0;

    bool inChk = pos.inCheck();
    int standPat = pos.eval();

    if (!inChk) {
        if (standPat >= beta) return beta;
        if (standPat + 975 < alpha) return alpha;
        if (standPat > alpha) alpha = standPat;
    }

    std::vector<Move> moves = inChk ? pos.genMoves() : pos.genCaptures();
    if (moves.empty()) return inChk ? -(100000 - ply) : alpha;

    // SEE pruning : ignorer les captures perdantes dans la qsearch
    if (!inChk) {
        moves.erase(std::remove_if(moves.begin(), moves.end(), [&](const Move& mv){
            if (mv.enPassant) return false;
            return see(pos, mv) < 0;
        }), moves.end());
        // Trier par valeur de la victime
        std::sort(moves.begin(), moves.end(), [](const Move& a, const Move& b){
            return PIECE_VAL[(int)a.captured] > PIECE_VAL[(int)b.captured];
        });
    }

    for (auto& mv : moves) {
        UndoInfo u = pos.doMove(mv);
        int score = -qsearch(pos, -beta, -alpha, ply+1);
        pos.undoMove(mv, u);
        if (aborted) return 0;
        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
    }
    return alpha;
}

int ChessAI::negamax(Position& pos, int depth, int alpha, int beta,
                     int ply, bool nullOk)
{
    nodes++;
    if ((nodes & 0xFFF) == 0 && timeUp()) { aborted = true; return 0; }
    if (aborted) return 0;

    int origAlpha = alpha;
    bool isPV = (beta - alpha) > 1;

    // TT probe
    Move ttMove = Move::null();
    {
        int ttScore; Move tmpM = Move::null();
        if (tt.probe(pos.zobrist, depth, alpha, beta, ttScore, tmpM)) {
            if (!isPV) return ttScore;
        }
        if (tmpM.valid()) ttMove = tmpM;
    }

    if (depth == 0) return qsearch(pos, alpha, beta, ply);

    bool inCheck = pos.inCheck();

    // Reverse futility pruning
    if (!inCheck && !isPV && depth <= 6 && std::abs(beta) < 90000) {
        int se = pos.eval();
        if (se - depth * 80 >= beta) return se - depth * 80;
    }

    // Razoring
    if (!inCheck && !isPV && depth <= 3 && std::abs(alpha) < 90000) {
        int se = pos.eval();
        int margin = 200 + depth * 100;
        if (se + margin < alpha) {
            int qsc = qsearch(pos, alpha-1, alpha, ply);
            if (!aborted && qsc < alpha) return qsc;
        }
    }

    // Null-move pruning
    if (nullOk && !inCheck && !isPV && depth >= 3 && ply > 0 && !isEndgame(pos)) {
        int R = depth >= 5 ? 3 : 2;
        Position copy = pos;
        copy.wtm = !copy.wtm;
        copy.zobrist ^= ZB_SIDE;
        if (copy.epFile >= 0) { copy.zobrist ^= ZB_EP[copy.epFile]; copy.epFile = -1; }
        int nullScore = -negamax(copy, depth-R-1, -beta, -beta+1, ply+1, false);
        if (!aborted && nullScore >= beta) return beta;
    }

    auto moves = pos.genMoves();
    if (moves.empty()) return inCheck ? -(100000 - ply) : 0;

    sortMoves(moves, pos, ttMove, killers, history, ply);

    Move best = Move::null();
    int  bestScore = -200000;

    for (int i = 0; i < (int)moves.size(); i++) {
        if (aborted) break;
        auto& mv = moves[i];

        UndoInfo u = pos.doMove(mv);
        bool givesCheck = pos.inCheck();
        int  ext = (givesCheck || mv.promo != EMPTY) ? 1 : 0;
        int  newDepth = depth - 1 + ext;

        int score;
        if (i == 0) {
            score = -negamax(pos, newDepth, -beta, -alpha, ply+1, true);
        } else {
            bool lmr = !inCheck && !givesCheck && ext==0
                       && i >= 4 && depth >= 3
                       && mv.captured==EMPTY && mv.promo==EMPTY;
            if (lmr) {
                score = -negamax(pos, newDepth-1, -alpha-1, -alpha, ply+1, true);
                if (!aborted && score > alpha)
                    score = -negamax(pos, newDepth, -alpha-1, -alpha, ply+1, true);
            } else {
                score = -negamax(pos, newDepth, -alpha-1, -alpha, ply+1, true);
            }
            if (!aborted && score > alpha && score < beta)
                score = -negamax(pos, newDepth, -beta, -alpha, ply+1, true);
        }

        pos.undoMove(mv, u);
        if (aborted) break;

        if (score > bestScore) { bestScore = score; best = mv; }
        if (score > alpha)     alpha = score;
        if (alpha >= beta) {
            if (mv.captured==EMPTY && mv.promo==EMPTY) {
                killers[ply][1] = killers[ply][0];
                killers[ply][0] = mv;
                history[(int)mv.piece][(int)mv.to] += depth * depth;
            }
            break;
        }
    }

    if (!aborted && best.valid()) {
        TTFlag flag = bestScore <= origAlpha ? TT_UPPER
                    : bestScore >= beta      ? TT_LOWER
                                             : TT_EXACT;
        int storeScore = bestScore;
        if (storeScore >  90000) storeScore += ply;
        if (storeScore < -90000) storeScore -= ply;
        tt.store(pos.zobrist, depth, storeScore, flag, best);
    }
    return bestScore;
}

Move ChessAI::findBestMove(Position pos, int timeLimitMs) {
    if (!bookBuilt) buildBook();

    // Livre d'ouverture (jusqu'au coup 25)
    if (pos.fullmove <= 25) {
        Move bm = probeBook(pos);
        if (bm.valid()) {
            bestMove = bm; depth = 0; score = 0; nodes = 0;
            return bm;
        }
    }

    startTime = std::chrono::steady_clock::now();
    timeLimit = timeLimitMs;
    aborted   = false;
    nodes     = 0;
    resetSearchState();

    Move result = Move::null();
    int  lastScore = 0;

    for (int d = 1; d <= 50; d++) {
        if (d > 1 && timeUp()) break;

        aborted = false;
        int delta = 50, alpha, beta;
        if (d < 4 || std::abs(lastScore) >= 90000) {
            alpha = -200000; beta = 200000;
        } else {
            alpha = lastScore - delta;
            beta  = lastScore + delta;
        }

        int sc = 0;
        while (true) {
            sc = negamax(pos, d, alpha, beta, 0, true);
            if (aborted) break;
            if      (sc <= alpha) { delta*=2; alpha=lastScore-delta; if(delta>1000) alpha=-200000; }
            else if (sc >= beta)  { delta*=2; beta =lastScore+delta; if(delta>1000) beta = 200000; }
            else break;
            if (timeUp()) { aborted=true; break; }
        }
        if (aborted) break;

        Move ttBest = tt.bestMove(pos.zobrist);
        if (ttBest.valid()) {
            auto legal = pos.genMoves();
            for (auto& lm : legal)
                if (lm.from==ttBest.from && lm.to==ttBest.to && lm.promo==ttBest.promo)
                    { result=lm; break; }
        }

        lastScore = sc;
        depth     = d;
        score     = pos.wtm ? sc : -sc;

        if (std::abs(sc) >= 99000) break;
        if (timeUp()) break;
    }

    if (!result.valid()) {
        auto legal = pos.genMoves();
        if (!legal.empty()) result = legal[0];
    }
    bestMove = result;
    return result;
}
