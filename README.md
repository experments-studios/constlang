<p align="center">
  <img src="logo.png" alt="ConstLang Logo" width="120"/>
</p>

# ConstLang Language Reference

ConstLang is a lightweight browser-based programming language that compiles into JavaScript.  
It supports modular programming, macros, and standard JavaScript control flow.  
It is ideal for learning programming concepts or rapid prototyping directly in the browser.

---

## 📦 Detailed Command Reference

| Command / Directive | Description | Usage Example | JavaScript Output / Notes |
|--------------------|------------|---------------|--------------------------|
| `set var = value;` | Declares a variable. ConstLang automatically converts it to `let` in JS. | ```clg set count = 5; ``` | `let count = 5;` |
| `console.print(expr);` | Prints an expression or message to the console. Converts to `console.log()`. | ```clg console.print("Hello!"); ``` | `console.log("Hello!");` |
| `alert.data(expr);` | Shows a popup alert with the given message. | ```clg alert.data("Done!"); ``` | `alert("Done!");` |
| `addon() { ... }` | Raw JavaScript block. Anything inside is included as-is. Useful for complex JS logic. | ```clg addon() { let x = 10; } ``` | `{ let x = 10; }` |
| `#import file.clg` | Imports another ConstLang file from the project. Supports modular design. | ```clg #import utils.clg ``` | *(No JS output; preprocessor only)* |
| `#install URL` | Downloads and includes external code from a URL. Useful for libraries. | ```clg #install https://cdn.example.com/lib.js ``` | *(No JS output; preprocessor only)* |
| `new.command()[ ... command() ... ]` | Defines a custom macro. Allows creating new language commands. | ```clg new.command()[ print ${cmd^text} command() console.log(${cmd^text}); ] ``` | Expands to JavaScript as specified in the macro |
| `if (condition) { ... }` | Standard conditional. Executes block if condition is true. | ```clg if (x > 5) { console.print(x); } ``` | Same as JS |
| `else if (condition) { ... }` | Conditional branch after `if`. | ```clg else if (x == 5) { console.print("Equal"); } ``` | Same as JS |
| `else { ... }` | Default branch for `if`. | ```clg else { console.print("Less"); } ``` | Same as JS |
| `for (init; condition; increment) { ... }` | For loop with initializer, condition, increment. | ```clg for (set i=0; i<3; i=i+1) { console.print(i); } ``` | Same as JS |
| `while (condition) { ... }` | Executes a block repeatedly while condition is true. | ```clg while (i<5) { i=i+1; } ``` | Same as JS |
| `do { ... } while (condition);` | Executes a block at least once, then checks the condition. | ```clg do { i=i+1; } while (i<5); ``` | Same as JS |
| `switch (expr) { case ... }` | Switch-case conditional structure. | ```clg switch(x){case 1:console.print("One");break;} ``` | Same as JS |
| `break` | Exits the nearest loop or switch block. | ```clg break; ``` | Same as JS |
| `continue` | Skips to the next iteration of the nearest loop. | ```clg continue; ``` | Same as JS |

> ⚠️ Note: Any standard JavaScript code not recognized as a ConstLang-specific command passes through unchanged.

---

## 🧩 Example Code (All Inside Markdown)

### Variables & Console
```clg
set name = "ConstLang";
console.print("Welcome to " + name);
alert.data("Initialization complete!");
