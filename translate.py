# -*- coding: utf-8 -*-
import subprocess, sys, tkinter

ZWSP, ZWNJ, ZWJ = '\u200b', '\u200c', '\u200d'

MORSE = {
    'A': '.-',    'B': '-...',  'C': '-.-.',  'D': '-..',
    'E': '.',     'F': '..-.',  'G': '--.',   'H': '....',
    'I': '..',    'J': '.---',  'K': '-.-',   'L': '.-..',
    'M': '--',    'N': '-.',    'O': '---',   'P': '.--.',
    'Q': '--.-',  'R': '.-.',   'S': '...',   'T': '-',
    'U': '..-',   'V': '...-',  'W': '.--',   'X': '-..-',
    'Y': '-.--',  'Z': '--..',
    '0': '-----', '1': '.----', '2': '..---', '3': '...--',
    '4': '....-', '5': '.....', '6': '-....', '7': '--...',
    '8': '---..', '9': '----.'
}

def encode(text):
    words = []
    for word in text.upper().split():
        codes = []
        for ch in word:
            if ch in MORSE:
                codes.append(''.join(ZWSP if c == '.' else ZWNJ for c in MORSE[ch]))
        if codes:
            words.append(ZWJ.join(codes))
    return (ZWJ * 2).join(words)

def to_clipboard(s):
    try:
        r = tkinter.Tk()
        r.withdraw()
        r.clipboard_clear()
        r.clipboard_append(s)
        r.update()
        r.destroy()
        return True
    except Exception:
        pass
    # 备用命令行工具
    cmd = {'win32': ['clip'], 'darwin': ['pbcopy']}.get(sys.platform)
    if cmd:
        subprocess.run(cmd, input=s.encode(), check=True)
        return True
    for c in (['xclip', '-selection', 'clipboard'], ['xsel', '-ib']):
        try:
            subprocess.run(c, input=s.encode(), check=True)
            return True
        except FileNotFoundError:
            continue
    return False

if __name__ == '__main__':
    text = ' '.join(sys.argv[1:]) or input('输入字母/数字: ')
    zw = encode(text)
    ok = to_clipboard(zw)
    print('已复制到剪贴板' if ok else '复制失败，请手动复制：')