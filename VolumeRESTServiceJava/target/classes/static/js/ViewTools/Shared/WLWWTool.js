//
// The Window Level / Window Width tool. Responds to mouse input and updates the WL/WW accordingly.
//
function WLWWTool(windowLevel, windowWidth, minMouseXDelta, minMouseYDelta) {
    var self = this;

    // Observable ko inputs
    self.WindowLevel = windowLevel;
    self.WindowWidth = windowWidth;

    // Object state
    self.WLWWMinMouseXDelta = minMouseXDelta;
    self.WLWWMinMouseYDelta = minMouseYDelta;
    self.WLWWLastMouseXPos = null;
    self.WLWWLastMouseYPos = null;
    self.WLWWLastWindowWidth = null;
    self.WLWWLastWindowLevel = null;

    // Mouse event handlers
    self.MouseDown = function () {
        if (event.buttons == 3) {
            self.WLWWLastMouseXPos = event.layerX;
            self.WLWWLastMouseYPos = event.layerY;
            self.WLWWLastWindowWidth = self.WindowWidth();
            self.WLWWLastWindowLevel = self.WindowLevel();
        }
    }

    self.MouseMove = function () {
        if (event.buttons == 3) {
            if (Math.abs(self.WLWWLastMouseXPos - event.layerX) >= self.WLWWMinMouseXDelta) {
                var delta = self.WLWWLastMouseXPos - event.layerX;

                var wlDelta = Math.round(delta / self.WLWWMinMouseXDelta);

                self.WindowWidth(self.WLWWLastWindowWidth - wlDelta);
            }

            if (Math.abs(self.WLWWLastMouseYPos - event.layerY) >= self.WLWWMinMouseYDelta) {
                var delta = self.WLWWLastMouseYPos - event.layerY;

                var wwDelta = Math.round(delta / self.WLWWMinMouseYDelta);

                self.WindowLevel(self.WLWWLastWindowLevel - wwDelta);
            }

            return false;
        }
    }
}