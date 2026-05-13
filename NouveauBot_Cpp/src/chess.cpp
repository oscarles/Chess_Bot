#include "chess.h"
#include <algorithm>
#include <cstring>
#include <sstream>
#include <stdexcept>

// ─── Tables d'attaques ────────────────────────────────────────────────────────
U64 KNIGHT_ATK[64];
U64 KING_ATK[64];
U64 PAWN_ATK[2][64];
U64 ZB_PC[12][64], ZB_SIDE, ZB_CAST[16], ZB_EP[8];

static U64 xrand(U64& s) {
    s ^= s << 13; s ^= s >> 7; s ^= s << 17; return s;
}

void initTables() {
    // Attaques cavalier / roi
    for (int sq = 0; sq < 64; sq++) {
        int r = sq / 8, f = sq % 8;
        U64 n = 0, k = 0, wp = 0, bp = 0;
        int kd[][2] = {{-1,-1},{-1,0},{-1,1},{0,-1},{0,1},{1,-1},{1,0},{1,1}};
        int nd[][2] = {{-2,-1},{-2,1},{-1,-2},{-1,2},{1,-2},{1,2},{2,-1},{2,1}};
        for (auto& d : nd) {
            int nr = r+d[0], nf = f+d[1];
            if (nr>=0&&nr<8&&nf>=0&&nf<8) n |= 1ULL<<(nr*8+nf);
        }
        for (auto& d : kd) {
            int nr = r+d[0], nf = f+d[1];
            if (nr>=0&&nr<8&&nf>=0&&nf<8) k |= 1ULL<<(nr*8+nf);
        }
        // Attaques pion blanc (attaque vers le haut = rank+1)
        if (r < 7) {
            if (f > 0) wp |= 1ULL << ((r+1)*8 + f-1);
            if (f < 7) wp |= 1ULL << ((r+1)*8 + f+1);
        }
        // Attaques pion noir (attaque vers le bas = rank-1)
        if (r > 0) {
            if (f > 0) bp |= 1ULL << ((r-1)*8 + f-1);
            if (f < 7) bp |= 1ULL << ((r-1)*8 + f+1);
        }
        KNIGHT_ATK[sq]  = n;
        KING_ATK[sq]    = k;
        PAWN_ATK[WHITE][sq] = wp;
        PAWN_ATK[BLACK][sq] = bp;
    }
    // Clés Zobrist
    U64 seed = 0xdeadbeefcafe1234ULL;
    for (int p = 0; p < 12; p++)
        for (int s = 0; s < 64; s++)
            ZB_PC[p][s] = xrand(seed);
    ZB_SIDE = xrand(seed);
    for (int i = 0; i < 16; i++) ZB_CAST[i] = xrand(seed);
    for (int i = 0; i <  8; i++) ZB_EP[i]   = xrand(seed);
}

// ─── Attaques glissantes ──────────────────────────────────────────────────────
U64 rookAttacks(int sq, U64 occ) {
    U64 atk = 0, bit = 1ULL << sq, ray;
    ray = bit; while ((ray <<= 8))              { atk |= ray; if (ray & occ) break; }
    ray = bit; while ((ray >>= 8))              { atk |= ray; if (ray & occ) break; }
    ray = bit; while ((ray = (ray<<1) & ~FILE_A)) { atk |= ray; if (ray & occ) break; }
    ray = bit; while ((ray = (ray>>1) & ~FILE_H)) { atk |= ray; if (ray & occ) break; }
    return atk;
}
U64 bishopAttacks(int sq, U64 occ) {
    U64 atk = 0, bit = 1ULL << sq, ray;
    ray = bit; while ((ray = (ray<<9) & ~FILE_A)) { atk |= ray; if (ray & occ) break; }
    ray = bit; while ((ray = (ray<<7) & ~FILE_H)) { atk |= ray; if (ray & occ) break; }
    ray = bit; while ((ray = (ray>>7) & ~FILE_A)) { atk |= ray; if (ray & occ) break; }
    ray = bit; while ((ray = (ray>>9) & ~FILE_H)) { atk |= ray; if (ray & occ) break; }
    return atk;
}

// ─── Position : helpers internes ─────────────────────────────────────────────
void Position::put(int sq, Piece p) {
    bd[sq] = (uint8_t)p;
    bb[p] |= 1ULL << sq;
    if (colorOf(p) == WHITE) white |= 1ULL << sq;
    else                     black |= 1ULL << sq;
    occ |= 1ULL << sq;
    if (p != EMPTY) {
        int v[] = {100,320,330,500,900,20000};
        int sign = colorOf(p) == WHITE ? 1 : -1;
        material += sign * v[typeOf(p)];
    }
}
void Position::remove(int sq) {
    Piece p = (Piece)bd[sq];
    if (p == EMPTY) return;
    int v[] = {100,320,330,500,900,20000};
    int sign = colorOf(p) == WHITE ? 1 : -1;
    material -= sign * v[typeOf(p)];
    bb[p]  &= ~(1ULL << sq);
    white  &= ~(1ULL << sq);
    black  &= ~(1ULL << sq);
    occ    &= ~(1ULL << sq);
    bd[sq]  = (uint8_t)EMPTY;
}
void Position::rehash() {
    zobrist = 0;
    for (int s = 0; s < 64; s++)
        if (bd[s] != EMPTY) zobrist ^= ZB_PC[bd[s]][s];
    if (!wtm)          zobrist ^= ZB_SIDE;
    zobrist ^= ZB_CAST[castling];
    if (epFile >= 0)   zobrist ^= ZB_EP[epFile];
}

// ─── Initialisation ───────────────────────────────────────────────────────────
Position::Position() { reset(); }

void Position::reset() {
    memset(bb,  0, sizeof(bb));
    memset(bd,  12, sizeof(bd));   // 12 = EMPTY
    white = black = occ = 0;
    wtm = true; castling = 0; epFile = -1;
    halfmove = 0; fullmove = 1; zobrist = 0; material = 0;
}

void Position::fromFen(const std::string& fen) {
    reset();
    std::istringstream ss(fen);
    std::string board, turn, castStr, epStr;
    int hm, fm;
    ss >> board >> turn >> castStr >> epStr >> hm >> fm;
    if (ss.fail()) { hm = 0; fm = 1; }
    halfmove = (uint8_t)hm;
    fullmove = fm;
    wtm = (turn == "w");

    // Pièces
    int rank = 7, file = 0;
    const char* pc = "PNBRQKpnbrqk";
    for (char c : board) {
        if (c == '/') { rank--; file = 0; }
        else if (c >= '1' && c <= '8') file += c - '0';
        else {
            const char* found = strchr(pc, c);
            if (found) {
                Piece p = (Piece)(found - pc);
                put(rank*8 + file, p);
            }
            file++;
        }
    }

    // Roques
    castling = 0;
    for (char c : castStr) {
        if (c=='K') castling |= 1;
        if (c=='Q') castling |= 2;
        if (c=='k') castling |= 4;
        if (c=='q') castling |= 8;
    }

    // En passant
    epFile = -1;
    if (epStr.size() >= 2 && epStr[0] != '-')
        epFile = (int8_t)(epStr[0] - 'a');

    rehash();
}

// ─── Génération de coups ──────────────────────────────────────────────────────
void Position::genPawnMoves(std::vector<Move>& mv, bool captOnly) const {
    Color us = side(), them = this->them();
    Piece myPawn = mkPiece(us, PAWN);
    U64 pawns = bb[myPawn];
    U64 enemy = us == WHITE ? black : white;
    U64 promoRank = us == WHITE ? RANK_8 : RANK_1;
    U64 startRank = us == WHITE ? RANK_2 : RANK_7;

    while (pawns) {
        int sq = pop(pawns);
        U64 bit = 1ULL << sq;

        // Captures (et promotions avec capture)
        U64 caps = PAWN_ATK[us][sq] & enemy;
        while (caps) {
            int to = pop(caps);
            Piece cap = (Piece)bd[to];
            if ((1ULL << to) & promoRank) {
                for (PType pt : {QUEEN, ROOK, BISHOP, KNIGHT}) {
                    Move m; m.from=sq; m.to=to; m.piece=myPawn;
                    m.captured=cap; m.promo=mkPiece(us,pt);
                    mv.push_back(m);
                }
            } else {
                Move m; m.from=sq; m.to=to; m.piece=myPawn; m.captured=cap;
                mv.push_back(m);
            }
        }

        // En passant
        if (epFile >= 0) {
            int epRank = us == WHITE ? 5 : 2;
            int epSq = epRank * 8 + epFile;
            if (PAWN_ATK[us][sq] & (1ULL << epSq)) {
                int capSq = (epRank + (us==WHITE?-1:1)) * 8 + epFile;
                Move m; m.from=sq; m.to=epSq; m.piece=myPawn;
                m.captured=(Piece)bd[capSq]; m.enPassant=true;
                mv.push_back(m);
            }
        }

        if (captOnly) continue;

        // Avances
        int fwd = us == WHITE ? 8 : -8;
        int to1 = sq + fwd;
        if (to1 >= 0 && to1 < 64 && bd[to1] == EMPTY) {
            if ((1ULL << to1) & promoRank) {
                for (PType pt : {QUEEN, ROOK, BISHOP, KNIGHT}) {
                    Move m; m.from=sq; m.to=to1; m.piece=myPawn;
                    m.promo=mkPiece(us,pt);
                    mv.push_back(m);
                }
            } else {
                Move m; m.from=sq; m.to=to1; m.piece=myPawn;
                mv.push_back(m);
                // Double avance depuis la position de départ
                if ((bit & startRank) && bd[to1+fwd] == EMPTY) {
                    Move m2; m2.from=sq; m2.to=to1+fwd; m2.piece=myPawn;
                    m2.doublePush=true;
                    mv.push_back(m2);
                }
            }
        }
    }
}

void Position::genPieceMoves(std::vector<Move>& mv, bool captOnly) const {
    Color us = side();
    U64 mine = us == WHITE ? white : black;
    U64 notMine = ~mine;

    // Cavaliers
    U64 knights = bb[mkPiece(us, KNIGHT)];
    while (knights) {
        int sq = pop(knights);
        U64 targets = KNIGHT_ATK[sq] & notMine;
        if (captOnly) targets &= occ;
        while (targets) {
            int to = pop(targets);
            Move m; m.from=sq; m.to=to; m.piece=mkPiece(us,KNIGHT);
            m.captured=(Piece)bd[to];
            mv.push_back(m);
        }
    }
    // Fous
    U64 bishops = bb[mkPiece(us, BISHOP)];
    while (bishops) {
        int sq = pop(bishops);
        U64 targets = bishopAttacks(sq, occ) & notMine;
        if (captOnly) targets &= occ;
        while (targets) {
            int to = pop(targets);
            Move m; m.from=sq; m.to=to; m.piece=mkPiece(us,BISHOP);
            m.captured=(Piece)bd[to];
            mv.push_back(m);
        }
    }
    // Tours
    U64 rooks = bb[mkPiece(us, ROOK)];
    while (rooks) {
        int sq = pop(rooks);
        U64 targets = rookAttacks(sq, occ) & notMine;
        if (captOnly) targets &= occ;
        while (targets) {
            int to = pop(targets);
            Move m; m.from=sq; m.to=to; m.piece=mkPiece(us,ROOK);
            m.captured=(Piece)bd[to];
            mv.push_back(m);
        }
    }
    // Dames
    U64 queens = bb[mkPiece(us, QUEEN)];
    while (queens) {
        int sq = pop(queens);
        U64 targets = queenAttacks(sq, occ) & notMine;
        if (captOnly) targets &= occ;
        while (targets) {
            int to = pop(targets);
            Move m; m.from=sq; m.to=to; m.piece=mkPiece(us,QUEEN);
            m.captured=(Piece)bd[to];
            mv.push_back(m);
        }
    }
}

void Position::genKingMoves(std::vector<Move>& mv, bool captOnly) const {
    Color us = side();
    Piece myKing = mkPiece(us, KING);
    U64 kings = bb[myKing];
    if (!kings) return;
    int sq = lsb(kings);
    U64 mine = us == WHITE ? white : black;
    U64 targets = KING_ATK[sq] & ~mine;
    if (captOnly) targets &= occ;

    while (targets) {
        int to = pop(targets);
        Move m; m.from=sq; m.to=to; m.piece=myKing;
        m.captured=(Piece)bd[to];
        mv.push_back(m);
    }

    if (captOnly) return;

    // Roques
    Color them = this->them();
    if (us == WHITE) {
        // Petit roque blanc
        if ((castling & 1) && !(occ & 0x60ULL) &&
            !attacked(4,them) && !attacked(5,them) && !attacked(6,them)) {
            Move m; m.from=4; m.to=6; m.piece=myKing; m.castling=true;
            mv.push_back(m);
        }
        // Grand roque blanc
        if ((castling & 2) && !(occ & 0x0EULL) &&
            !attacked(4,them) && !attacked(3,them) && !attacked(2,them)) {
            Move m; m.from=4; m.to=2; m.piece=myKing; m.castling=true;
            mv.push_back(m);
        }
    } else {
        // Petit roque noir
        if ((castling & 4) && !(occ & 0x6000000000000000ULL) &&
            !attacked(60,them) && !attacked(61,them) && !attacked(62,them)) {
            Move m; m.from=60; m.to=62; m.piece=myKing; m.castling=true;
            mv.push_back(m);
        }
        // Grand roque noir
        if ((castling & 8) && !(occ & 0x0E00000000000000ULL) &&
            !attacked(60,them) && !attacked(59,them) && !attacked(58,them)) {
            Move m; m.from=60; m.to=58; m.piece=myKing; m.castling=true;
            mv.push_back(m);
        }
    }
}

std::vector<Move> Position::genMoves() const {
    std::vector<Move> pseudo;
    pseudo.reserve(64);
    genPawnMoves(pseudo, false);
    genPieceMoves(pseudo, false);
    genKingMoves(pseudo, false);

    // Filtrer les coups illégaux (roi en échec après le coup)
    std::vector<Move> legal;
    legal.reserve(pseudo.size());
    for (auto& m : pseudo) {
        Position copy = *this;
        UndoInfo u = copy.doMove(m);
        // Après le coup, vérifier si notre roi est en échec
        Color moved = copy.wtm ? BLACK : WHITE; // on vient de jouer pour 'moved'
        U64 kings = copy.bb[mkPiece(moved, KING)];
        if (!kings) continue;
        int kSq = lsb(kings);
        if (!copy.attacked(kSq, copy.side())) {
            legal.push_back(m);
        }
        (void)u;
    }
    return legal;
}

std::vector<Move> Position::genCaptures() const {
    std::vector<Move> pseudo;
    pseudo.reserve(32);
    genPawnMoves(pseudo, true);
    genPieceMoves(pseudo, true);
    genKingMoves(pseudo, true);

    std::vector<Move> legal;
    legal.reserve(pseudo.size());
    for (auto& m : pseudo) {
        Position copy = *this;
        copy.doMove(m);
        Color moved = copy.wtm ? BLACK : WHITE;
        U64 kings = copy.bb[mkPiece(moved, KING)];
        if (!kings) continue;
        int kSq = lsb(kings);
        if (!copy.attacked(kSq, copy.side())) legal.push_back(m);
    }
    return legal;
}

// ─── Appliquer / défaire un coup ─────────────────────────────────────────────
UndoInfo Position::doMove(Move m) {
    UndoInfo u;
    u.castling = castling;
    u.epFile   = epFile;
    u.halfmove = halfmove;
    u.zobrist  = zobrist;

    Color us = side();

    // Effacer l'ancienne clé
    zobrist ^= ZB_CAST[castling];
    if (epFile >= 0) zobrist ^= ZB_EP[epFile];

    // Mettre à jour l'horloge de 50 coups
    if (typeOf(m.piece) == PAWN || m.captured != EMPTY) halfmove = 0;
    else halfmove++;

    // Déplacer la pièce
    Piece movingPiece = m.piece;
    remove(m.from);
    zobrist ^= ZB_PC[movingPiece][m.from];

    if (m.enPassant) {
        int capRank = us == WHITE ? 4 : 3;
        int capSq = capRank * 8 + m.to % 8;
        zobrist ^= ZB_PC[bd[capSq]][capSq];
        remove(capSq);
    } else if (m.captured != EMPTY) {
        zobrist ^= ZB_PC[m.captured][m.to];
        remove(m.to);
    }

    Piece placed = m.promo != EMPTY ? m.promo : movingPiece;
    put(m.to, placed);
    zobrist ^= ZB_PC[placed][m.to];

    // Roque : déplacer aussi la tour
    if (m.castling) {
        if (m.to == 6)  { // Blanc petit roque
            zobrist ^= ZB_PC[W_ROOK][7]; remove(7);
            put(5, W_ROOK); zobrist ^= ZB_PC[W_ROOK][5];
        } else if (m.to == 2) { // Blanc grand roque
            zobrist ^= ZB_PC[W_ROOK][0]; remove(0);
            put(3, W_ROOK); zobrist ^= ZB_PC[W_ROOK][3];
        } else if (m.to == 62) { // Noir petit roque
            zobrist ^= ZB_PC[B_ROOK][63]; remove(63);
            put(61, B_ROOK); zobrist ^= ZB_PC[B_ROOK][61];
        } else if (m.to == 58) { // Noir grand roque
            zobrist ^= ZB_PC[B_ROOK][56]; remove(56);
            put(59, B_ROOK); zobrist ^= ZB_PC[B_ROOK][59];
        }
    }

    // Mettre à jour les droits de roque
    if (m.from == 4  || m.to == 4 ) castling &= ~3;
    if (m.from == 60 || m.to == 60) castling &= ~12;
    if (m.from == 7  || m.to == 7 ) castling &= ~1;
    if (m.from == 0  || m.to == 0 ) castling &= ~2;
    if (m.from == 63 || m.to == 63) castling &= ~4;
    if (m.from == 56 || m.to == 56) castling &= ~8;

    // En passant : activer si double avance
    epFile = -1;
    if (m.doublePush) epFile = (int8_t)(m.to % 8);

    // Changer de camp
    wtm = !wtm;
    if (wtm) fullmove++;

    // Mettre à jour la clé
    zobrist ^= ZB_SIDE;
    zobrist ^= ZB_CAST[castling];
    if (epFile >= 0) zobrist ^= ZB_EP[epFile];

    return u;
}

void Position::undoMove(Move m, UndoInfo u) {
    wtm = !wtm;
    if (!wtm) fullmove--;

    Color us = side();

    // Retirer la pièce à la destination
    Piece placed = m.promo != EMPTY ? m.promo : m.piece;
    remove(m.to);

    // Remettre la pièce à l'origine
    put(m.from, m.piece);

    // Restaurer la capture normale
    if (!m.enPassant && m.captured != EMPTY) {
        put(m.to, m.captured);
    }
    // En passant : remettre le pion capturé
    if (m.enPassant) {
        int capRank = us == WHITE ? 4 : 3;
        int capSq = capRank * 8 + m.to % 8;
        put(capSq, m.captured);
    }
    // Roque : remettre la tour
    if (m.castling) {
        if (m.to == 6)  { remove(5);  put(7,  W_ROOK); }
        if (m.to == 2)  { remove(3);  put(0,  W_ROOK); }
        if (m.to == 62) { remove(61); put(63, B_ROOK); }
        if (m.to == 58) { remove(59); put(56, B_ROOK); }
    }

    castling = u.castling;
    epFile   = u.epFile;
    halfmove = u.halfmove;
    zobrist  = u.zobrist;
}

// ─── Détection d'attaque / échec ──────────────────────────────────────────────
bool Position::attacked(int sq, Color by) const {
    if (PAWN_ATK[by ^ 1][sq] & bb[mkPiece(by, PAWN)])   return true;
    if (KNIGHT_ATK[sq]        & bb[mkPiece(by, KNIGHT)]) return true;
    if (KING_ATK[sq]          & bb[mkPiece(by, KING)])   return true;
    U64 bishopQueens = bb[mkPiece(by,BISHOP)] | bb[mkPiece(by,QUEEN)];
    if (bishopAttacks(sq, occ) & bishopQueens)            return true;
    U64 rookQueens   = bb[mkPiece(by,ROOK)]  | bb[mkPiece(by,QUEEN)];
    if (rookAttacks(sq, occ)   & rookQueens)              return true;
    return false;
}

bool Position::inCheck() const {
    U64 kings = bb[mkPiece(side(), KING)];
    if (!kings) return false;
    return attacked(lsb(kings), them());
}

// ─── Évaluation tapée (PeSTO MG+EG) ─────────────────────────────────────────
// Index 0 = A8 (en haut à gauche du point de vue blanc).
// Blancs : (7-rank)*8+file     Noirs : rank*8+file

static const int PST_MG[6][64] = {
// PAWN
{  0,  0,  0,  0,  0,  0,  0,  0,
  98,134, 61, 95, 68,126, 34,-11,
  -6,  7, 26, 31, 65, 56, 25,-20,
 -14, 13,  6, 21, 23, 12, 17,-23,
 -27, -2, -5, 12, 17,  6, 10,-25,
 -26, -4, -4,-10,  3,  3, 33,-12,
 -35, -1,-20,-23,-15, 24, 38,-22,
   0,  0,  0,  0,  0,  0,  0,  0},
// KNIGHT
{-167,-89,-34,-49, 61,-97,-15,-107,
  -73,-41, 72, 36, 23, 62,  7, -17,
  -47, 60, 37, 65, 84,129, 73,  44,
   -9, 17, 19, 53, 37, 69, 18,  22,
  -13,  4, 16, 13, 28, 19, 21,  -8,
  -23, -9, 12, 10, 19, 17, 25, -16,
  -29,-53,-12, -3, -1, 18,-14, -19,
 -105,-21,-58,-33,-17,-28,-19, -23},
// BISHOP
{ -29,  4,-82,-37,-25,-42,  7, -8,
  -26, 16,-18,-13, 30, 59, 18,-47,
  -16, 37, 43, 40, 35, 50, 37, -2,
   -4,  5, 19, 50, 37, 37,  7, -2,
   -6, 13, 13, 26, 34, 12, 10,  4,
    0, 15, 15, 15, 14, 27, 18, 10,
    4, 15, 16,  0,  7, 21, 33,  1,
  -33, -3,-14,-21,-13,-12,-39,-21},
// ROOK
{  32, 42, 32, 51, 63,  9, 31, 43,
   27, 32, 58, 62, 80, 67, 26, 44,
   -5, 19, 26, 36, 17, 45, 61, 16,
  -24,-11,  7, 26, 24, 35, -8,-20,
  -36,-26,-12, -1,  9, -7,  6,-23,
  -45,-25,-16,-17,  3,  0, -5,-33,
  -44,-16,-20, -9, -1, 11, -6,-71,
  -19,-13,  1, 17, 16,  7,-37,-26},
// QUEEN
{ -28,  0, 29, 12, 59, 44, 43, 45,
  -24,-39, -5,  1,-16, 57, 28, 54,
  -13,-17,  7,  8, 29, 56, 47, 57,
  -27,-27,-16,-16, -1, 17, -2,  1,
   -9,-26, -9,-10, -2, -4,  3, -3,
  -14,  2,-11, -2, -5,  2, 14,  5,
  -35, -8, 11,  2,  8, 15, -3,  1,
   -1,-18, -9, 10,-15,-25,-31,-50},
// KING MG
{ -65, 23, 16,-15,-56,-34,  2, 13,
   29, -1,-20, -7, -8, -4,-38,-29,
   -9, 24,  2,-16,-20,  6, 22,-22,
  -17,-20,-12,-27,-30,-25,-14,-36,
  -49, -1,-27,-39,-46,-44,-33,-51,
  -14,-14,-22,-46,-44,-30,-15,-27,
    1,  7, -8,-64,-43,-16,  9,  8,
  -15, 36, 12,-54,  8,-28, 24, 14}
};

static const int PST_EG[6][64] = {
// PAWN EG
{  0,  0,  0,  0,  0,  0,  0,  0,
 178,173,158,134,147,132,165,187,
  94,100, 85, 67, 56, 53, 82, 84,
  32, 24, 13,  5, -2,  4, 17, 17,
  13,  9, -3, -7, -7, -8,  3, -1,
   4,  7, -6,  1,  0, -5, -1, -8,
  13,  8,  8, 10, 13,  0,  2, -7,
   0,  0,  0,  0,  0,  0,  0,  0},
// KNIGHT EG
{ -58,-38,-13,-28,-31,-27,-63,-99,
  -25, -8,-25, -2, -9,-25,-24,-52,
  -24,-20, 10,  9, -1, -9,-19,-41,
  -17,  3, 22, 22, 22, 11,  8,-18,
  -18, -6, 16, 25, 16, 17,  4,-18,
  -23, -3, -1, 15, 10, -3,-20,-22,
  -42,-20,-10, -5, -2,-20,-23,-44,
  -29,-51,-23,-15,-22,-18,-50,-64},
// BISHOP EG
{ -14,-21,-11, -8, -7, -9,-17,-24,
   -8, -4,  7,-12, -3,-13, -4,-14,
    2, -8,  0, -1, -2,  6,  0,  4,
   -3,  9, 12,  9, 14, 10,  3,  2,
   -6,  3, 13, 19,  7, 10, -3, -9,
  -12, -3,  8, 10, 13,  3, -7,-15,
  -14,-18, -7, -1,  4, -9,-15,-27,
  -23, -9,-23, -5, -9,-16, -5,-17},
// ROOK EG
{  13, 10, 18, 15, 12, 12,  8,  5,
   11, 13, 13, 11, -3,  3,  8,  3,
    7,  7,  7,  5,  4, -3, -5, -3,
    4,  3, 13,  1,  2,  1, -1,  2,
    3,  5,  8,  4, -5, -6, -8,-11,
   -4,  0, -5, -1, -7,-12, -8,-16,
   -6, -6,  0,  2, -9, -9,-11, -3,
   -9,  2,  3, -1, -5,-13,  4,-20},
// QUEEN EG
{  -9, 22, 22, 27, 27, 19, 10, 20,
  -17, 20, 32, 41, 58, 25, 30,  0,
  -20,  6,  9, 49, 47, 35, 19,  9,
    3, 22, 24, 45, 57, 40, 57, 36,
  -18, 28, 19, 47, 31, 34, 39, 23,
  -16,-27, 15,  6,  9, 17, 10,  5,
  -22,-23,-30,-16,-16,-23,-36,-32,
  -33,-28,-22,-43, -5,-32,-20,-41},
// KING EG
{ -74,-35,-18,-18,-11, 15,  4,-17,
  -12, 17, 14, 17, 17, 38, 23, 11,
   10, 17, 23, 15, 20, 45, 44, 13,
   -8, 22, 24, 27, 26, 33, 26,  3,
  -18, -4, 21, 24, 27, 23,  9,-11,
  -19, -3, 11, 21, 23, 16,  7, -9,
  -27,-11,  4, 13, 14,  4, -5,-17,
  -53,-34,-21,-11,-28,-14,-24,-43}
};

static const int PASSED_BONUS_MG[8] = {0, 5,10,15,25, 50, 90,0};
static const int PASSED_BONUS_EG[8] = {0,10,20,35,60,100,160,0};
constexpr int MAX_PHASE = 24;

int Position::eval() const {
    // Phase (plus les pièces lourdes restent, plus on est en milieu de partie)
    int phase = 4*(popcnt(bb[W_QUEEN]) +popcnt(bb[B_QUEEN]))
              + 2*(popcnt(bb[W_ROOK])  +popcnt(bb[B_ROOK]))
              +   (popcnt(bb[W_BISHOP])+popcnt(bb[B_BISHOP]))
              +   (popcnt(bb[W_KNIGHT])+popcnt(bb[B_KNIGHT]));
    if (phase > MAX_PHASE) phase = MAX_PHASE;
    int egPhase = MAX_PHASE - phase;

    // Matériel + PST tapé
    int mg = material, eg = material;
    for (int sq = 0; sq < 64; sq++) {
        Piece p = (Piece)bd[sq];
        if (p == EMPTY) continue;
        PType  pt   = typeOf(p);
        int    rank = sq/8, file = sq%8;
        int    idx  = (colorOf(p)==WHITE) ? (7-rank)*8+file : rank*8+file;
        int    sign = (colorOf(p)==WHITE) ? 1 : -1;
        mg += sign * PST_MG[pt][idx];
        eg += sign * PST_EG[pt][idx];
    }

    // Structure de pions
    int wPF[8]={}, bPF[8]={};
    { U64 t=bb[W_PAWN]; while(t){int s=pop(t);wPF[s%8]++;} }
    { U64 t=bb[B_PAWN]; while(t){int s=pop(t);bPF[s%8]++;} }

    // Doublés
    for(int f=0;f<8;f++){
        if(wPF[f]>1){mg-=(wPF[f]-1)*10;eg-=(wPF[f]-1)*20;}
        if(bPF[f]>1){mg+=(bPF[f]-1)*10;eg+=(bPF[f]-1)*20;}
    }
    // Isolés
    for(int f=0;f<8;f++){
        int wa=(f>0?wPF[f-1]:0)+(f<7?wPF[f+1]:0);
        if(wPF[f]>0&&wa==0){mg-=wPF[f]*12;eg-=wPF[f]*18;}
        int ba=(f>0?bPF[f-1]:0)+(f<7?bPF[f+1]:0);
        if(bPF[f]>0&&ba==0){mg+=bPF[f]*12;eg+=bPF[f]*18;}
    }
    // Passés
    {
        U64 t=bb[W_PAWN];
        while(t){
            int sq=pop(t); int r=sq/8,f=sq%8;
            bool ok=true;
            for(int dc=-1;dc<=1&&ok;dc++){
                int fc=f+dc; if(fc<0||fc>7) continue;
                for(int rr=r+1;rr<8;rr++) if((bb[B_PAWN]>>(rr*8+fc))&1){ok=false;break;}
            }
            if(ok){int adv=r-1;if(adv>=0&&adv<=6){mg+=PASSED_BONUS_MG[adv];eg+=PASSED_BONUS_EG[adv];}}
        }
        t=bb[B_PAWN];
        while(t){
            int sq=pop(t); int r=sq/8,f=sq%8;
            bool ok=true;
            for(int dc=-1;dc<=1&&ok;dc++){
                int fc=f+dc; if(fc<0||fc>7) continue;
                for(int rr=r-1;rr>=0;rr--) if((bb[W_PAWN]>>(rr*8+fc))&1){ok=false;break;}
            }
            if(ok){int adv=6-r;if(adv>=0&&adv<=6){mg-=PASSED_BONUS_MG[adv];eg-=PASSED_BONUS_EG[adv];}}
        }
    }

    // Paire de fous
    if(popcnt(bb[W_BISHOP])>=2){mg+=30;eg+=50;}
    if(popcnt(bb[B_BISHOP])>=2){mg-=30;eg-=50;}

    // Tours sur colonnes ouvertes / semi-ouvertes
    { U64 t=bb[W_ROOK]; while(t){int f=pop(t)%8;
        if(!wPF[f]&&!bPF[f]){mg+=15;eg+=10;} else if(!wPF[f]){mg+=10;eg+=5;} } }
    { U64 t=bb[B_ROOK]; while(t){int f=pop(t)%8;
        if(!bPF[f]&&!wPF[f]){mg-=15;eg-=10;} else if(!bPF[f]){mg-=10;eg-=5;} } }

    // Sécurité du roi
    auto kingSafety = [&](Color c) -> int {
        U64 kb = bb[mkPiece(c,KING)]; if(!kb) return 0;
        int kSq=lsb(kb), kr=kSq/8, kf=kSq%8;
        int home=(c==WHITE)?0:7, fwd=(c==WHITE)?1:-1;
        U64 ownP=bb[mkPiece(c,PAWN)];
        int* oPF=(c==WHITE)?wPF:bPF;
        int* ePF=(c==WHITE)?bPF:wPF;
        int pen=0;
        if(std::abs(kr-home)<=1){
            for(int dc=-1;dc<=1;dc++){
                int nc=kf+dc; if(nc<0||nc>7) continue;
                int r1=kr+fwd, r2=kr+2*fwd;
                bool s1=(r1>=0&&r1<8&&((ownP>>(r1*8+nc))&1));
                bool s2=(r2>=0&&r2<8&&((ownP>>(r2*8+nc))&1));
                if(s1){}else if(s2)pen-=12;else pen-=25;
            }
        }
        for(int dc=-1;dc<=1;dc++){
            int nc=kf+dc; if(nc<0||nc>7) continue;
            if(!oPF[nc]&&!ePF[nc])pen-=18;
            else if(!oPF[nc])pen-=10;
        }
        return pen;
    };
    int kd = kingSafety(WHITE) - kingSafety(BLACK);
    mg += kd; eg += kd/4;

    // Heuristique fin de partie : pousser le roi seul vers le bord
    {
        int wPc=popcnt(bb[W_QUEEN]|bb[W_ROOK]|bb[W_BISHOP]|bb[W_KNIGHT]);
        int bPc=popcnt(bb[B_QUEEN]|bb[B_ROOK]|bb[B_BISHOP]|bb[B_KNIGHT]);
        bool bBare=(bPc==0&&popcnt(bb[B_PAWN])==0);
        bool wBare=(wPc==0&&popcnt(bb[W_PAWN])==0);
        if(bb[W_KING]&&bb[B_KING]){
            int wK=lsb(bb[W_KING]),bK=lsb(bb[B_KING]);
            int wKr=wK/8,wKf=wK%8,bKr=bK/8,bKf=bK%8;
            if(bBare&&wPc>=1){
                int ed=std::min({bKr,7-bKr,bKf,7-bKf});
                int kd2=std::max(std::abs(wKr-bKr),std::abs(wKf-bKf));
                eg+=(3-ed)*20+(7-kd2)*12;
            } else if(wBare&&bPc>=1){
                int ed=std::min({wKr,7-wKr,wKf,7-wKf});
                int kd2=std::max(std::abs(wKr-bKr),std::abs(wKf-bKf));
                eg-=(3-ed)*20+(7-kd2)*12;
            }
        }
    }

    int score = (mg*phase + eg*egPhase) / MAX_PHASE;
    return wtm ? score : -score;
}
