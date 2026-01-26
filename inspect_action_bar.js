// Paste this into browser console while in-game to inspect DOM structure

const actionName = document.querySelector('div[class*="Header_actionName"]');
if (actionName) {
    console.log("=== ACTION NAME ELEMENT ===");
    console.log("Element:", actionName);
    console.log("Text:", actionName.textContent);
    console.log("\n=== PARENT CHAIN ===");
    
    let parent = actionName;
    let level = 0;
    while (parent && level < 6) {
        console.log(`Level ${level}:`, parent.className, parent.tagName);
        console.log("  Style width:", parent.style.width);
        console.log("  Computed width:", window.getComputedStyle(parent).width);
        console.log("  Computed max-width:", window.getComputedStyle(parent).maxWidth);
        parent = parent.parentElement;
        level++;
    }
    
    console.log("\n=== LOOKING FOR PROGRESS BAR ===");
    // The progress bar is typically a sibling or nearby element
    const container = actionName.closest('[class*="ActionBar"]') || actionName.closest('[class*="Header"]');
    if (container) {
        console.log("Container:", container.className);
        const progressBar = container.querySelector('[class*="progress"], [class*="bar"]');
        if (progressBar) {
            console.log("Progress bar:", progressBar.className);
            console.log("Progress bar width:", window.getComputedStyle(progressBar).width);
        }
    }
}
