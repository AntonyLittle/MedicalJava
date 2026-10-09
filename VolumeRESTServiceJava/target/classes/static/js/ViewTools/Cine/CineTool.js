//
// The Cine tool. Responds to mouse input and updates the currently viewed slice accordingly.
//
function CineTool(cineViewModel, minMouseYDelta) {
    var self = this;

    // Observable ko input
    self.CineViewModel = cineViewModel;


    // Object state
    self.CineMinMouseYDelta = minMouseYDelta;
    self.CinePressedMouseYPos = null;
    self.CinePressedSliceIndex = 0;

    // Mouse event handlers
    self.MouseDown = function () {
        if (event.buttons == 2) {
            self.CinePressedMouseYPos = event.layerY;
            self.CinePressedSliceIndex = self.CineViewModel.CurrentSliceIndex();
        }
    }

    self.MouseMove = function () {
        if (event.buttons == 2) {
            if (Math.abs(self.CinePressedMouseYPos - event.layerY) >= self.CineMinMouseYDelta) {
                var delta = self.CinePressedMouseYPos - event.layerY;
                var sliceDelta = Math.round(delta / self.CineMinMouseYDelta);

                self.CineViewModel.ChangeCurrentSliceIndex(self.CinePressedSliceIndex - sliceDelta);
            }

            return false;
        }
    }
}