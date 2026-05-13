#include <SFML/Graphics.hpp>
#include <future>
#include <chrono>
#include <optional>
#include <fstream>
#include <sstream>
#include <ctime>
#include <algorithm>
#include <cmath>
#include <windows.h>
#include "chess.h"
#include "ai.h"

// ─── Dimensions ──────────────────────────────────────────────────────────────
constexpr unsigned SQ   = 80;
constexpr unsigned BSIZ = SQ * 8;      // 640
constexpr unsigned PW   = 300;         // largeur panneau
constexpr unsigned WW   = BSIZ + PW;   // 940
constexpr unsigned WH   = BSIZ;        // 640

// ─── Palette ─────────────────────────────────────────────────────────────────
namespace C {
    const sf::Color SQ_L  {240,217,181};
    const sf::Color SQ_D  {181,136, 99};
    const sf::Color BG    { 32, 32, 45};
    const sf::Color PNL   { 22, 22, 32};
    const sf::Color SECT  { 35, 35, 50};
    const sf::Color SEL   {100,200,100,160};
    const sf::Color LAST  {255,215,  0, 80};
    const sf::Color DOT   { 20, 85,130,160};
    const sf::Color CHK   {220, 50, 50,180};
    const sf::Color BTN   { 65,105,170};
    const sf::Color BTN_H { 85,135,210};
    const sf::Color BTN_A { 45, 70,120};
    const sf::Color GOLD  {255,200, 50};
    const sf::Color RED   {220, 70, 70};
    const sf::Color GRN   { 80,190,100};
    const sf::Color TXT   {220,220,220};
    const sf::Color TXT_S {140,140,155};
    const sf::Color WPC   {248,243,225};   // couleur pièce blanche
    const sf::Color BPC   { 25, 18, 12};   // couleur pièce noire
    const sf::Color W_OL  { 70, 50, 30,210};// contour pièce blanche
    const sf::Color B_OL  {200,185,165,210};// contour pièce noire
}

// Codes Unicode pour les pièces (symboles remplis)
// On utilise les symboles "noirs" (♚=0x265A … ♟=0x265F) pour les deux couleurs,
// en changeant juste la couleur de remplissage.
constexpr uint32_t PIECE_CP[12] = {
    0x265F,0x265E,0x265D,0x265C,0x265B,0x265A, // blancs : ♟♞♝♜♛♚
    0x265F,0x265E,0x265D,0x265C,0x265B,0x265A  // noirs  : même glyphes, autre couleur
};

// ─── Clipboard (Windows) ─────────────────────────────────────────────────────
static void copyClipboard(const std::string& s) {
    if (!OpenClipboard(nullptr)) return;
    EmptyClipboard();
    HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, s.size() + 1);
    if (h) {
        memcpy(GlobalLock(h), s.c_str(), s.size() + 1);
        GlobalUnlock(h);
        SetClipboardData(CF_TEXT, h);
    }
    CloseClipboard();
}

// ─── Bouton ──────────────────────────────────────────────────────────────────
struct Button {
    sf::Vector2f pos, sz;
    std::string  label;
    bool         hovered = false, active = false;

    Button() = default;
    Button(float x, float y, float w, float h, std::string lbl)
        : pos{x,y}, sz{w,h}, label(std::move(lbl)) {}

    bool contains(int mx, int my) const {
        return mx>=pos.x && mx<pos.x+sz.x && my>=pos.y && my<pos.y+sz.y;
    }
    void draw(sf::RenderWindow& win, const sf::Font& font) const {
        sf::RectangleShape r(sz);
        r.setPosition(pos);
        r.setFillColor(active ? C::BTN_A : hovered ? C::BTN_H : C::BTN);
        r.setOutlineThickness(1);
        r.setOutlineColor(sf::Color(100,130,180,120));
        win.draw(r);
        sf::Text t(font, label, 13);
        t.setFillColor(sf::Color::White);
        auto b = t.getLocalBounds();
        t.setPosition({pos.x+(sz.x-b.size.x)*.5f-b.position.x,
                       pos.y+(sz.y-b.size.y)*.5f-b.position.y});
        win.draw(t);
    }
};

// ─── Champ texte ─────────────────────────────────────────────────────────────
struct TextBox {
    sf::Vector2f pos, sz;
    std::string  value, placeholder;
    bool         active = false;
    float        blink  = 0;

    TextBox() = default;
    TextBox(float x, float y, float w, float h, std::string ph)
        : pos{x,y}, sz{w,h}, placeholder(std::move(ph)) {}

    bool contains(int mx, int my) const {
        return mx>=pos.x && mx<pos.x+sz.x && my>=pos.y && my<pos.y+sz.y;
    }
    void input(uint32_t unicode) {
        if (!active) return;
        if (unicode == 8) { if (!value.empty()) value.pop_back(); }
        else if (unicode == 13) { active = false; }
        else if (unicode >= 32 && unicode < 127) value += (char)unicode;
    }
    void update(float dt) { blink = fmodf(blink + dt, 1.f); }
    void draw(sf::RenderWindow& win, const sf::Font& font) const {
        sf::RectangleShape bg(sz);
        bg.setPosition(pos);
        bg.setFillColor(active ? sf::Color(45,45,65) : sf::Color(30,30,45));
        bg.setOutlineThickness(1.5f);
        bg.setOutlineColor(active ? sf::Color(80,120,200) : sf::Color(60,60,80));
        win.draw(bg);
        bool empty = value.empty();
        sf::Text t(font, empty ? placeholder : value, 12);
        t.setFillColor(empty ? C::TXT_S : C::TXT);
        t.setPosition({pos.x+6, pos.y+(sz.y-t.getLocalBounds().size.y)*.5f
                       -t.getLocalBounds().position.y});
        win.draw(t);
        if (active && !empty && blink < .5f) {
            float cx = pos.x + 6 + t.getLocalBounds().size.x + 2;
            sf::RectangleShape cur({1.5f, sz.y-8});
            cur.setPosition({cx, pos.y+4});
            cur.setFillColor(C::TXT);
            win.draw(cur);
        }
    }
};

// ─── Historique des coups ─────────────────────────────────────────────────────
struct MoveRec { Move m; std::string san; Color mover; int fullNum; };

// ─── Notation SAN ─────────────────────────────────────────────────────────────
std::string toSAN(const Position& before, Move m) {
    if (m.castling) return (m.to > m.from) ? "O-O" : "O-O-O";
    PType pt = typeOf(m.piece);
    std::string san;
    if (pt != PAWN) {
        const char PL[] = "NBRQK";
        san += PL[pt-1];
        // Disambiguation
        auto lm = before.genMoves();
        bool sameFile=false, sameRank=false, ambig=false;
        for (auto& am : lm) {
            if (am.from==m.from || am.to!=m.to || am.piece!=m.piece) continue;
            ambig = true;
            if (am.from%8==m.from%8) sameFile=true;
            if (am.from/8==m.from/8) sameRank=true;
        }
        if (ambig) {
            if (!sameFile)       san += (char)('a'+m.from%8);
            else if (!sameRank)  san += (char)('1'+m.from/8);
            else { san += (char)('a'+m.from%8); san += (char)('1'+m.from/8); }
        }
    }
    bool cap = (m.captured!=EMPTY || m.enPassant);
    if (cap) { if (pt==PAWN) san += (char)('a'+m.from%8); san += 'x'; }
    san += (char)('a'+m.to%8);
    san += (char)('1'+m.to/8);
    if (m.promo!=EMPTY) {
        const char PL[] = "NBRQ";
        san += '='; san += PL[typeOf(m.promo)-1];
    }
    return san;
}
std::string addCheckSuffix(std::string san, const Position& after) {
    auto mv = after.genMoves();
    if (mv.empty() && after.inCheck()) return san+'#';
    if (after.inCheck()) return san+'+';
    return san;
}

// ─── Génération PGN ──────────────────────────────────────────────────────────
std::string buildPGN(const std::vector<MoveRec>& hist,
                     Color playerColor, const std::string& result)
{
    std::ostringstream pgn;
    time_t now = time(nullptr); char datebuf[16];
    strftime(datebuf, sizeof(datebuf), "%Y.%m.%d", localtime(&now));
    std::string white = (playerColor==WHITE) ? "Joueur" : "ChessBot C++";
    std::string black = (playerColor==BLACK) ? "Joueur" : "ChessBot C++";
    pgn << "[Event \"Partie locale\"]\n[Date \""<<datebuf<<"\"]\n"
        << "[White \""<<white<<"\"]\n[Black \""<<black<<"\"]\n"
        << "[Result \""<<result<<"\"]\n\n";
    int curFull = 1; bool wseen = false;
    for (size_t i = 0; i < hist.size(); i++) {
        if (hist[i].mover==WHITE) { pgn<<hist[i].fullNum<<". "<<hist[i].san<<" "; wseen=true; }
        else { if (!wseen) pgn<<hist[i].fullNum<<"... "; pgn<<hist[i].san<<" "; wseen=false; }
    }
    pgn << result << "\n";
    return pgn.str();
}

// ─── Conversion case ↔ écran ─────────────────────────────────────────────────
sf::Vector2f sqToPixel(int sq, bool flipped) {
    int file = sq%8, rank = sq/8;
    float px = flipped ? (float)((7-file)*SQ) : (float)(file*SQ);
    float py = flipped ? (float)(rank*SQ)      : (float)((7-rank)*SQ);
    return {px, py};
}
int pixelToSq(int mx, int my, bool flipped) {
    int col = mx/SQ, row = my/SQ;
    if (col<0||col>7||row<0||row>7) return -1;
    return flipped ? (7-row)*8+(7-col) : (7-row)*8+col;
}

// ─── Dessin d'une pièce ───────────────────────────────────────────────────────
void drawPiece(sf::RenderWindow& win, const sf::Font& pf, const sf::Font& fb,
               Piece p, float x, float y)
{
    if (p==EMPTY) return;
    bool isW = colorOf(p)==WHITE;

    // Essayer Unicode avec la police pièces
    uint32_t cp32 = PIECE_CP[p];
    sf::String ps = sf::String::fromUtf32(&cp32, &cp32 + 1);
    unsigned fsz = (unsigned)(SQ*0.82f);
    sf::Text piece(pf, ps, fsz);

    // Centrage
    auto b = piece.getLocalBounds();
    // Vérifier que le glyphe a été trouvé (taille non nulle)
    bool glyphOk = b.size.x > 5.f;

    if (!glyphOk) {
        // Fallback : cercle + lettre
        const char* LBL[] = {"P","N","B","R","Q","K","P","N","B","R","Q","K"};
        sf::CircleShape c(SQ*0.38f);
        c.setPosition({x+SQ*0.12f, y+SQ*0.12f});
        c.setFillColor(isW ? C::WPC : C::BPC);
        c.setOutlineThickness(2.5f);
        c.setOutlineColor(isW ? C::W_OL : C::B_OL);
        win.draw(c);
        sf::Text lbl(fb, LBL[p], 26);
        lbl.setStyle(sf::Text::Bold);
        lbl.setFillColor(isW ? C::BPC : C::WPC);
        auto lb = lbl.getLocalBounds();
        lbl.setPosition({x+(SQ-lb.size.x)*.5f-lb.position.x,
                         y+(SQ-lb.size.y)*.5f-lb.position.y-2.f});
        win.draw(lbl);
        return;
    }

    float cx = x+(SQ-b.size.x)*.5f-b.position.x;
    float cy = y+(SQ-b.size.y)*.5f-b.position.y;

    // Contour/ombre (dessinée en couleur inverse, légèrement décalée)
    sf::Color olCol = isW ? C::W_OL : C::B_OL;
    sf::Text shadow(pf, ps, fsz);
    shadow.setFillColor(olCol);
    for (auto [dx,dy] : std::initializer_list<std::pair<int,int>>
         {{-1,0},{1,0},{0,-1},{0,1},{-1,-1},{1,1},{-1,1},{1,-1}})
    {
        shadow.setPosition({cx+(float)dx, cy+(float)dy});
        win.draw(shadow);
    }
    // Pièce principale
    piece.setFillColor(isW ? C::WPC : C::BPC);
    piece.setPosition({cx, cy});
    win.draw(piece);
}

// ─── Texte utilitaire ─────────────────────────────────────────────────────────
static void txt(sf::RenderWindow& w, const sf::Font& f,
                const std::string& s, float x, float y,
                unsigned sz=14, sf::Color c=C::TXT, bool bold=false)
{
    sf::Text t(f,s,sz);
    if (bold) t.setStyle(sf::Text::Bold);
    t.setFillColor(c);
    t.setPosition({x,y});
    w.draw(t);
}

// ─── Dessin de l'échiquier ────────────────────────────────────────────────────
void drawBoard(sf::RenderWindow& win, const sf::Font& pieceFont,
               const sf::Font& uiFont, const Position& pos,
               int selSq, const std::vector<Move>& legal,
               int lastFrom, int lastTo, bool flipped,
               const std::vector<MoveRec>& hist)
{
    // Fond du plateau
    sf::RectangleShape boardBg({(float)BSIZ+8,(float)BSIZ+8});
    boardBg.setPosition({-4,-4});
    boardBg.setFillColor(sf::Color(15,15,22));
    win.draw(boardBg);

    for (int rank=7; rank>=0; rank--) {
        for (int file=0; file<8; file++) {
            int sq = rank*8+file;
            auto [px,py] = sqToPixel(sq, flipped);
            bool light = (rank+file)%2==1;

            sf::RectangleShape rect({(float)SQ,(float)SQ});
            rect.setPosition({px,py});
            rect.setFillColor(light ? C::SQ_L : C::SQ_D);
            win.draw(rect);

            // Dernier coup
            if (sq==lastFrom||sq==lastTo) {
                rect.setFillColor(C::LAST); win.draw(rect);
            }
            // Roi en échec
            if (pos.inCheck()) {
                U64 kg=pos.bb[mkPiece(pos.side(),KING)];
                if (kg && lsb(kg)==sq) { rect.setFillColor(C::CHK); win.draw(rect); }
            }
            // Sélection
            if (sq==selSq) { rect.setFillColor(C::SEL); win.draw(rect); }
            // Destinations légales
            for (auto& m : legal) {
                if (m.to!=sq) continue;
                if ((Piece)pos.bd[sq]!=EMPTY) {
                    sf::RectangleShape bdr({(float)(SQ-6),(float)(SQ-6)});
                    bdr.setPosition({px+3,py+3});
                    bdr.setFillColor(sf::Color::Transparent);
                    bdr.setOutlineThickness(3.5f);
                    bdr.setOutlineColor(sf::Color(200,60,60,210));
                    win.draw(bdr);
                } else {
                    sf::CircleShape dot(11.f);
                    dot.setPosition({px+SQ*0.5f-11.f,py+SQ*0.5f-11.f});
                    dot.setFillColor(C::DOT);
                    win.draw(dot);
                }
                break;
            }
            // Coordonnées
            if ((flipped ? file==7 : file==0)) {
                sf::Text t(uiFont,std::to_string(rank+1),11);
                t.setFillColor(light?C::SQ_D:C::SQ_L);
                t.setPosition({px+3,py+2}); win.draw(t);
            }
            if ((flipped ? rank==7 : rank==0)) {
                sf::Text t(uiFont,std::string(1,(char)('a'+file)),11);
                t.setFillColor(light?C::SQ_D:C::SQ_L);
                t.setPosition({px+SQ-13.f,py+SQ-15.f}); win.draw(t);
            }
        }
    }

    // Pièces
    for (int sq=0; sq<64; sq++) {
        Piece p=(Piece)pos.bd[sq];
        if (p==EMPTY) continue;
        auto [px,py] = sqToPixel(sq,flipped);
        drawPiece(win, pieceFont, uiFont, p, px, py);
    }
}

// ─── Panneau latéral ──────────────────────────────────────────────────────────
void drawPanel(sf::RenderWindow& win, const sf::Font& font,
               const sf::Font& pf, const Position& pos,
               Color playerColor, bool thinking,
               const std::vector<MoveRec>& hist,
               int moveScroll, const std::string& statusMsg,
               const std::string& aiInfo,
               const std::vector<Button>& buttons,
               const TextBox& fenBox)
{
    float ox = (float)BSIZ;
    sf::RectangleShape bg({(float)PW,(float)WH});
    bg.setPosition({ox,0}); bg.setFillColor(C::PNL); win.draw(bg);

    // Séparateur gauche
    sf::RectangleShape sep({2,(float)WH});
    sep.setPosition({ox,0}); sep.setFillColor(sf::Color(60,60,80)); win.draw(sep);

    // ── Carte joueur noir ──────────────────────────────────────────────────
    {
        float y0=8;
        sf::RectangleShape card({PW-16.f,68.f});
        card.setPosition({ox+8,y0}); card.setFillColor(C::SECT);
        card.setOutlineThickness(1); card.setOutlineColor(sf::Color(55,55,75));
        win.draw(card);

        bool isBlackAI = (playerColor==WHITE);
        std::string name = isBlackAI ? "ChessBot C++" : "Vous";
        std::string sub  = isBlackAI
            ? (thinking && !pos.wtm ? "reflechit..." : "IA (Noirs)")
            : "Noirs";
        sf::Color nc = isBlackAI&&thinking&&!pos.wtm ? C::GOLD : C::TXT;

        // Icône pièce
        drawPiece(win,pf,font,B_KING, ox+12, y0+2);

        txt(win,font,name,ox+16+SQ*.65f,y0+10,15,nc,true);
        txt(win,font,sub, ox+16+SQ*.65f,y0+33,12,C::TXT_S);

        // Avantage matériel
        int adv = -pos.material;
        if (adv>0) {
            std::string s = "+"+std::to_string(adv);
            txt(win,font,s,ox+PW-50.f,y0+22,14,C::GRN,true);
        }
    }

    // ── Liste des coups ────────────────────────────────────────────────────
    {
        float y0=84; float listH=380;
        sf::RectangleShape bg2({PW-16.f,listH});
        bg2.setPosition({ox+8,y0}); bg2.setFillColor(sf::Color(28,28,40));
        bg2.setOutlineThickness(1); bg2.setOutlineColor(sf::Color(50,50,70));
        win.draw(bg2);
        txt(win,font,"Coups",ox+14,y0+4,12,C::TXT_S);

        // Scissoring via View pour la liste
        sf::View listView(sf::FloatRect({ox+8,y0+22},{PW-16.f,listH-26}));
        listView.setViewport(sf::FloatRect(
            {(ox+8.f)/WW, (y0+22.f)/WH},
            {(PW-16.f)/WW,(listH-26.f)/WH}));
        win.setView(listView);

        float ry=4-(float)moveScroll*18;
        int fullNum=1;
        for (size_t i=0; i<hist.size(); i+=2) {
            float rowY = y0+22+ry;
            sf::Text nt(font,std::to_string(fullNum)+".",13);
            nt.setFillColor(C::TXT_S);
            nt.setPosition({ox+8+4, rowY});
            win.draw(nt);
            if (i<hist.size()) {
                sf::Text wt(font,hist[i].san,13);
                wt.setFillColor(C::TXT);
                wt.setPosition({ox+8+42, rowY});
                win.draw(wt);
            }
            if (i+1<hist.size()) {
                sf::Text bt(font,hist[i+1].san,13);
                bt.setFillColor(sf::Color(190,190,190));
                bt.setPosition({ox+8+155, rowY});
                win.draw(bt);
            }
            ry+=18; fullNum++;
        }
        win.setView(win.getDefaultView());

        // Bordure après la vue
        sf::RectangleShape sep2({PW-16.f,1});
        sep2.setPosition({ox+8,y0+listH-1}); sep2.setFillColor(sf::Color(55,55,75));
        win.draw(sep2);
    }

    // ── Carte joueur blanc ────────────────────────────────────────────────
    {
        float y0=472;
        sf::RectangleShape card({PW-16.f,68.f});
        card.setPosition({ox+8,y0}); card.setFillColor(C::SECT);
        card.setOutlineThickness(1); card.setOutlineColor(sf::Color(55,55,75));
        win.draw(card);

        bool isWhiteAI = (playerColor==BLACK);
        std::string name = isWhiteAI ? "ChessBot C++" : "Vous";
        std::string sub  = isWhiteAI
            ? (thinking && pos.wtm ? "reflechit..." : "IA (Blancs)")
            : "Blancs";
        sf::Color nc = isWhiteAI&&thinking&&pos.wtm ? C::GOLD : C::TXT;

        drawPiece(win,pf,font,W_KING, ox+12, y0+2);
        txt(win,font,name,ox+16+SQ*.65f,y0+10,15,nc,true);
        txt(win,font,sub, ox+16+SQ*.65f,y0+33,12,C::TXT_S);

        int adv = pos.material;
        if (adv>0) {
            std::string s = "+"+std::to_string(adv);
            txt(win,font,s,ox+PW-50.f,y0+22,14,C::GRN,true);
        }
    }

    // ── Boutons ───────────────────────────────────────────────────────────
    for (auto& b : buttons) b.draw(win,font);

    // ── FEN ───────────────────────────────────────────────────────────────
    fenBox.draw(win,font);
    txt(win,font,"FEN :",ox+10,552,11,C::TXT_S);

    // ── Infos IA ──────────────────────────────────────────────────────────
    if (!aiInfo.empty())
        txt(win,font,aiInfo,ox+10,(float)(WH-20),11,C::TXT_S);

    // ── Message de statut ─────────────────────────────────────────────────
    if (!statusMsg.empty()) {
        float sw=0; for (char c:statusMsg) sw+=8;
        float sx=ox+(PW-sw)*.5f, sy=(float)WH/2-60;
        sf::RectangleShape bg3({sw+24,36});
        bg3.setPosition({sx-12,sy-8});
        bg3.setFillColor(sf::Color(20,20,30,220));
        bg3.setOutlineThickness(2); bg3.setOutlineColor(C::GOLD);
        win.draw(bg3);
        txt(win,font,statusMsg,sx,sy,16,C::GOLD,true);
    }
}

// ─── Promotion ────────────────────────────────────────────────────────────────
Piece askPromotion(sf::RenderWindow& win, const sf::Font& pf,
                   const sf::Font& uf, Color color)
{
    const Piece chW[4] = {W_QUEEN,W_ROOK,W_BISHOP,W_KNIGHT};
    const Piece chB[4] = {B_QUEEN,B_ROOK,B_BISHOP,B_KNIGHT};
    const Piece* ch = (color==WHITE) ? chW : chB;
    const char* lbl[4] = {"Dame","Tour","Fou","Cavalier"};

    while (win.isOpen()) {
        while (const auto ev = win.pollEvent()) {
            if (ev->is<sf::Event::Closed>()) { win.close(); return ch[0]; }
            if (const auto* mb = ev->getIf<sf::Event::MouseButtonPressed>()) {
                if (mb->button==sf::Mouse::Button::Left) {
                    for (int i=0;i<4;i++) {
                        float px=160.f+i*140, py=(float)WH/2-55;
                        if (mb->position.x>=px&&mb->position.x<px+120&&
                            mb->position.y>=py&&mb->position.y<py+130)
                            return ch[i];
                    }
                }
            }
        }
        win.clear(sf::Color(20,20,30));
        // Overlay semi-transparent
        sf::RectangleShape ov({(float)WW,(float)WH});
        ov.setFillColor(sf::Color(0,0,0,160)); win.draw(ov);

        // Fenêtre de choix
        float bw=120,bh=130,gap=20,total=4*bw+3*gap;
        float sx=(WW-total)*.5f, sy=(float)WH*.5f-65;
        sf::RectangleShape bg({total+40,bh+50});
        bg.setPosition({sx-20,sy-30});
        bg.setFillColor(sf::Color(30,30,45));
        bg.setOutlineThickness(2); bg.setOutlineColor(C::GOLD);
        win.draw(bg);
        txt(win,uf,"Choisir la promotion :",sx-5,sy-22,16,C::GOLD,true);

        for (int i=0;i<4;i++) {
            float px=sx+i*(bw+gap), py=sy;
            sf::RectangleShape card({bw,bh});
            card.setPosition({px,py});
            card.setFillColor(sf::Color(45,45,65));
            card.setOutlineThickness(1.5f); card.setOutlineColor(sf::Color(80,80,110));
            win.draw(card);
            drawPiece(win,pf,uf,ch[i],px+20,py+5);
            txt(win,uf,lbl[i],px+(bw-strlen(lbl[i])*7)*.5f,py+bh-22,12,C::TXT);
        }
        win.display();
    }
    return ch[0];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
int main() {
    initTables();

    sf::RenderWindow window(sf::VideoMode({WW,WH}), "Chess Bot C++",
        sf::Style::Titlebar|sf::Style::Close);
    window.setFramerateLimit(60);

    // Polices
    sf::Font uiFont, pieceFont;
    if (!uiFont.openFromFile("C:/Windows/Fonts/calibri.ttf") &&
        !uiFont.openFromFile("C:/Windows/Fonts/arial.ttf") &&
        !uiFont.openFromFile("C:/Windows/Fonts/tahoma.ttf"))
        return 1; // police requise pour UI

    bool hasPieceFont = pieceFont.openFromFile("C:/Windows/Fonts/seguisym.ttf");
    if (!hasPieceFont) pieceFont = uiFont; // fallback vers lettres

    // État du jeu
    Position pos;
    pos.fromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");

    ChessAI ai;
    Color playerColor = WHITE;  // le joueur joue les blancs par défaut
    bool flipped = false;

    int selSq=-1, lastFrom=-1, lastTo=-1;
    bool thinking=false;
    std::future<Move> aiFut;
    std::vector<Move> allLegal=pos.genMoves(), fromSel;
    std::vector<MoveRec> history;
    int moveScroll=0;
    std::string statusMsg, aiInfo;

    // Calcul offset Y des boutons
    float ox=(float)BSIZ;

    // Boutons du panneau
    auto mkBtn=[&](float rx,float ry,float w,float h,const std::string& l)->Button{
        return Button(ox+rx,ry,w,h,l);
    };
    std::vector<Button> buttons = {
        mkBtn(  8,549,130,22,"Nouvelle partie"),
        mkBtn(144,549,72,22,"Retourner"),
        mkBtn(  8,575,92,22,"Exporter PGN"),
        mkBtn(104,575,88,22,"Copier FEN"),
        mkBtn(196,575,96,22,"⬤ Blancs"),   // toggle couleur joueur
    };
    // Index sémantiques
    enum { BTN_NEW=0,BTN_FLIP,BTN_PGN,BTN_FEN,BTN_COLOR };

    TextBox fenBox(ox+8, 600, PW-16, 26, "Coller FEN ici puis Entrée...");

    auto startNewGame = [&](const std::string& fen = "") {
        if (aiFut.valid()) aiFut.wait();
        pos.fromFen(fen.empty()
            ? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
            : fen);
        ai.tt.clear();
        selSq=-1; lastFrom=-1; lastTo=-1; thinking=false;
        history.clear(); moveScroll=0; statusMsg=""; aiInfo="";
        allLegal=pos.genMoves(); fromSel.clear();
        // Si l'IA joue les blancs, la lancer immédiatement
        if (!allLegal.empty() && pos.side()==(playerColor==WHITE?BLACK:WHITE)) {
            thinking=true;
            Position cp=pos;
            aiFut=std::async(std::launch::async,[cp,&ai]()mutable{
                return ai.findBestMove(cp,1500);
            });
        }
    };

    auto applyMove = [&](Move m) {
        std::string san = toSAN(pos,m);
        UndoInfo u = pos.doMove(m);
        san = addCheckSuffix(san,pos);
        history.push_back({m,san,pos.wtm?BLACK:WHITE,pos.fullmove-(pos.wtm?0:1)});
        (void)u;
        lastFrom=m.from; lastTo=m.to;
        selSq=-1; fromSel.clear();
        allLegal=pos.genMoves();
        // Scroll automatique vers le bas
        int maxScroll=std::max(0,(int)(history.size()/2)-19);
        moveScroll=maxScroll;
        // Status
        if (allLegal.empty()) {
            statusMsg = pos.inCheck() ? "Echec et mat !" : "Pat - Partie nulle";
        } else if (pos.inCheck()) {
            statusMsg = "Echec !";
        } else {
            statusMsg = "";
        }
    };

    auto triggerAI = [&]() {
        if (!allLegal.empty() && !thinking &&
            pos.side()==(playerColor==WHITE?BLACK:WHITE))
        {
            thinking=true;
            Position cp=pos;
            aiFut=std::async(std::launch::async,[cp,&ai]()mutable{
                return ai.findBestMove(cp,1500);
            });
        }
    };

    sf::Clock clock;

    while (window.isOpen()) {
        float dt = clock.restart().asSeconds();
        fenBox.update(dt);

        // ── Résultat IA ──────────────────────────────────────────────────
        if (thinking && aiFut.valid()) {
            if (aiFut.wait_for(std::chrono::milliseconds(0))==std::future_status::ready) {
                Move m=aiFut.get(); thinking=false;
                aiInfo="Prof. "+std::to_string(ai.depth)
                      +"  Score "+(ai.score>=0?"+":"")+std::to_string(ai.score)
                      +"  Noeuds "+std::to_string(ai.nodes);
                if (m.valid() && !allLegal.empty()) {
                    applyMove(m);
                    // Pas de nouveau coup IA ici (c'est au joueur maintenant)
                }
            } else {
                aiInfo="Calcul en cours...";
            }
        }

        // ── Événements ──────────────────────────────────────────────────
        while (const auto ev=window.pollEvent()) {
            if (ev->is<sf::Event::Closed>()) window.close();

            if (const auto* kp=ev->getIf<sf::Event::KeyPressed>()) {
                if (kp->code==sf::Keyboard::Key::Escape) window.close();
                if (kp->code==sf::Keyboard::Key::R)      startNewGame();
                if (kp->code==sf::Keyboard::Key::F)      { flipped=!flipped; }
            }

            if (const auto* te=ev->getIf<sf::Event::TextEntered>()) {
                if (fenBox.active) {
                    uint32_t u=te->unicode;
                    if (u==13 && !fenBox.value.empty()) {
                        startNewGame(fenBox.value);
                        fenBox.value=""; fenBox.active=false;
                    } else fenBox.input(u);
                }
            }

            if (const auto* mb=ev->getIf<sf::Event::MouseButtonPressed>()) {
                if (mb->button!=sf::Mouse::Button::Left) continue;
                int mx=mb->position.x, my=mb->position.y;

                // Clic sur la FEN box
                fenBox.active = fenBox.contains(mx,my);

                // Clic sur les boutons
                bool clickedBtn=false;
                for (size_t i=0;i<buttons.size();i++) {
                    if (!buttons[i].contains(mx,my)) continue;
                    clickedBtn=true;
                    if (i==BTN_NEW) startNewGame();
                    else if (i==BTN_FLIP) { flipped=!flipped; }
                    else if (i==BTN_PGN) {
                        bool ww=(statusMsg.find("mat")!=std::string::npos&&pos.side()==BLACK);
                        bool bw=(statusMsg.find("mat")!=std::string::npos&&pos.side()==WHITE);
                        std::string res=ww?"1-0":bw?"0-1":
                            (statusMsg.find("nulle")!=std::string::npos?"1/2-1/2":"*");
                        std::string pgn=buildPGN(history,playerColor,res);
                        // Sauvegarde fichier
                        std::ofstream f("game.pgn"); f<<pgn;
                        copyClipboard(pgn);
                        statusMsg="PGN sauvegarde + copie !";
                    }
                    else if (i==BTN_FEN) {
                        // Copier FEN courante
                        // Génération FEN simple
                        std::ostringstream fen;
                        for (int rank=7;rank>=0;rank--) {
                            int empty=0;
                            for (int file=0;file<8;file++) {
                                Piece p=(Piece)pos.bd[rank*8+file];
                                if (p==EMPTY) { empty++; continue; }
                                if (empty) { fen<<empty; empty=0; }
                                const char* pcs="PNBRQKpnbrqk";
                                fen<<pcs[p];
                            }
                            if (empty) fen<<empty;
                            if (rank>0) fen<<'/';
                        }
                        fen<<(pos.wtm?" w ":" b ");
                        std::string cs;
                        if (pos.castling&1) cs+='K'; if (pos.castling&2) cs+='Q';
                        if (pos.castling&4) cs+='k'; if (pos.castling&8) cs+='q';
                        fen<<(cs.empty()?"-":cs)<<" ";
                        if (pos.epFile>=0) {
                            int epRank=pos.wtm?5:2;
                            fen<<(char)('a'+pos.epFile)<<(epRank+1);
                        } else fen<<"-";
                        fen<<" "<<(int)pos.halfmove<<" "<<pos.fullmove;
                        copyClipboard(fen.str());
                        statusMsg="FEN copiee dans le presse-papiers !";
                    }
                    else if (i==BTN_COLOR) {
                        playerColor=(playerColor==WHITE)?BLACK:WHITE;
                        flipped=(playerColor==BLACK);
                        buttons[BTN_COLOR].label=(playerColor==WHITE)?"⬤ Blancs":"⬤ Noirs";
                        startNewGame();
                    }
                    break;
                }

                // Clic sur l'échiquier
                if (!clickedBtn && mx<(int)BSIZ && !allLegal.empty()) {
                    if (thinking) continue;
                    // Vérifier que c'est le tour du joueur
                    if (pos.side()!=(playerColor==WHITE?WHITE:BLACK)) continue;

                    int sq=pixelToSq(mx,my,flipped);
                    if (sq<0) { selSq=-1; fromSel.clear(); continue; }

                    if (selSq>=0) {
                        // Chercher un coup légal
                        Move chosen=Move::null();
                        for (auto& m:fromSel) {
                            if (m.to!=sq) continue;
                            // Préférer dame pour promotion
                            if (m.promo==EMPTY||m.promo==W_QUEEN||m.promo==B_QUEEN)
                                chosen=m;
                        }
                        if (chosen.valid()) {
                            // Vérifier promotion
                            bool hasPromo=false;
                            for (auto& m:fromSel)
                                if (m.to==sq&&m.promo!=EMPTY){hasPromo=true;break;}
                            if (hasPromo) {
                                Piece pp=askPromotion(window,pieceFont,uiFont,pos.side());
                                chosen=Move::null();
                                for (auto& m:fromSel)
                                    if (m.to==sq&&m.promo==pp){chosen=m;break;}
                            }
                            if (chosen.valid()) {
                                applyMove(chosen);
                                triggerAI();
                            }
                        } else {
                            // Nouvelle sélection
                            selSq=-1; fromSel.clear();
                            Piece p=(Piece)pos.bd[sq];
                            if (p!=EMPTY&&colorOf(p)==pos.side()) {
                                selSq=sq;
                                for (auto& m:allLegal) if(m.from==sq) fromSel.push_back(m);
                            }
                        }
                    } else {
                        Piece p=(Piece)pos.bd[sq];
                        if (p!=EMPTY&&colorOf(p)==pos.side()) {
                            selSq=sq; fromSel.clear();
                            for (auto& m:allLegal) if(m.from==sq) fromSel.push_back(m);
                        }
                    }
                }
            }

            // Hover sur les boutons
            if (const auto* mm=ev->getIf<sf::Event::MouseMoved>()) {
                for (auto& b:buttons)
                    b.hovered=b.contains(mm->position.x,mm->position.y);
            }
        }

        // ── Rendu ────────────────────────────────────────────────────────
        window.clear(C::BG);

        // Fond global du plateau
        sf::RectangleShape boardArea({(float)BSIZ,(float)WH});
        boardArea.setFillColor(C::BG);
        window.draw(boardArea);

        drawBoard(window,pieceFont,uiFont,pos,selSq,fromSel,
                  lastFrom,lastTo,flipped,history);

        drawPanel(window,uiFont,pieceFont,pos,playerColor,thinking,
                  history,moveScroll,statusMsg,aiInfo,buttons,fenBox);

        window.display();
    }
    if (aiFut.valid()) aiFut.wait();
    return 0;
}
