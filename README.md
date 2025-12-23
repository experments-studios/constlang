<p>
  <img src="logo.png" alt="ConstLang Logo" width="60" height="60" style="vertical-align: middle; margin-right: 10px;">
  <span style="font-size: 28px; font-weight: bold; vertical-align: middle;"></span>
</p>

# ConstLang programing language v4.0.0
## © 2025 Ilkin Yahya. All rights reserved.

ConstLang is a lightweight browser-based programming language that compiles to JavaScript.

---

## ⚙️ Compiler Commands (3)

| Command | Description | Example |
|---------|-------------|---------|
| `compiler.add()` | Opens file picker to load `.clg` files. | `compiler.add();` |
| `compiler.start()` | Starts compilation process. | `compiler.start();` |
| `compiler.download()` | Downloads compiled JS file as `output.js`. | `compiler.download();` |

---

# Constlang v4.0.0 — Language Commands Reference

This document lists all built-in commands available in **Constlang v4.0.0**.
Each command is mapped to its corresponding runtime or target-language behavior.

---

## 1. Macro System (1)

### new.command
Defines a custom command using pattern–template mapping.

```clg
new.command()[
  print ${cmd^text}
  command()
  Console.WriteLine(${text});
]
```

---

## 2. GUI Commands (2)

### gui()
Defines GUI content. Extracted into a separate output file.

```clg
gui() {
  <button>OK</button>
}
```

### naviteapi()
Injects raw native code directly.

```clg
naviteapi() {
  Console.WriteLine("Native");
}
```

---

## 3. Import & Install Commands (2)

### #import
Imports another `.clg` file.

```clg
#import utils.clg
```

### #install
Loads external source code.

```clg
#install https://example.com/lib.clg
```

---

## 4. Variable & Type Commands (9)

### int
```clg
int x = 10;
```

### int16
### int32
### int64
### int128

### intx (Double)
```clg
intx pi = 3.14;
```

### string
```clg
string name = "Constlang";
```

### ft (Boolean)
```clg
ft ready = true;
```

### static
Defines constant values.

```clg
static int MAX = 100;
```

---

## 5. Console Output Commands (4)

### console.print
```clg
console.print("Hello");
```

### console.error
```clg
console.error("Error");
```

### alert.data
```clg
alert.data("Message");
```

### read.title
```clg
read.title("Enter value:");
```

---

## 6. Input Commands (7)

### read.int16
### read.int32
### read.int64
### read.intx
### read.string
### read.byte
### read.base64

```clg
read.int32(x);
```

---

## 7. HTTP Commands (3)

### get
```clg
get("endpoint");
```

---

## 8. Link Request Commands (3)

This command has been removed.


## 9. File Commands (6)

### file.add
### file.load
### file.move
### file.copy
### file.redata
### open.file

```clg
file.add("a.txt","data");
```

---

## 10. Folder Commands (5)

### folder.add
### folder.move
### folder.fileinfo
### folder.folderinfo
### open.folder

---

## 11. List Commands (14)

### .list.add
### .list.new
### .list.delente
### .list.count
### .list.index
### .list.control
### .list.clr
### .list.all
### .list.redata
### .list.join

### .list.string
### .list.int16
### .list.int32
### .list.int64
### .list.int128
### .list.intx

---

## 12. Regex Commands (5)

### regex.parse
### regex.search
### regex.mainsearch
### regex.control
### regex.replace

---

## 13. Flow Control Commands (5)

### if
### else
### else if
### while
### for

---

## 14. System Commands (4)

### system.beep
### system.control
### open.window
### lib.cs

```clg
system.beep(500);
```

---

## ✔ Total

- **Commands:** 74
- **Macro Systems:** 1
- **Version:** Constlang v4.0.0

