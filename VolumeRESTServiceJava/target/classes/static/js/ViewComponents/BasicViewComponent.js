//
// Basic view component. Aggregates a rendered underlay with a number of interactive tools.
//
// TODO:
//      Add Overlays in a similar manner to tools (demographics, annotations, etc.)
function BasicViewComponent() {
    var self = this;

    // Renderer for the underlay (must have a Draw() method)
    self.Renderer = null;

    // Tools - each must have one or more of: MouseDown, MouseUp, MouseMove
    self.Tools = [];

    // Bind all the tools to the underlay
    self.Bind = function (canvas) {

        // Use the array.forEach function here, so as to avoid the closure issues found with for(...) in javascript
        self.Tools.forEach(
            function (tool) {
                if (typeof tool.MouseDown === 'function') {
                    canvas.addEventListener("mousedown", function () { tool.MouseDown(); }, true)
                }

                if (typeof tool.MouseUp === 'function') {
                    canvas.addEventListener("mouseup", function () { tool.MouseUp(); }, true)
                }

                if (typeof tool.MouseMove === 'function') {
                    canvas.addEventListener("mousemove", function () { tool.MouseMove(); }, true)
                }
            }
        );
        // We don't want context menus on our nice image
        canvas.oncontextmenu = function (event) {
            return false;
        }
    }
}