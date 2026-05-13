@echo off
echo === Compilation Chess Bot C++ ===

set MSYS2=C:\msys64\mingw64\bin
set CMAKE=%MSYS2%\cmake.exe
set NINJA=%MSYS2%\ninja.exe
set CXX=%MSYS2%\g++.exe
set CC=%MSYS2%\gcc.exe

if not exist build mkdir build

REM Supprimer le cache CMake si présent (évite les conflits de détection précédents)
if exist build\CMakeCache.txt del build\CMakeCache.txt

cd build

%CMAKE% -G "Ninja" ^
    -DCMAKE_BUILD_TYPE=Release ^
    -DCMAKE_CXX_COMPILER="%CXX%" ^
    -DCMAKE_C_COMPILER="%CC%" ^
    -DCMAKE_MAKE_PROGRAM="%NINJA%" ^
    .. && (
    %NINJA% && (
        echo.
        echo === Compilation reussie ! ===
        echo Lancer : build\ChessBot.exe
    ) || (
        echo === ERREUR de compilation ===
    )
) || (
    echo === ERREUR CMake ===
)

cd ..
pause
