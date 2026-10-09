//
// Renders a slice onto the canvas. Updates occur when the Volume, WL/WW or current slice changes
//
// TODO:
//      Make allowances for voxel shapes and spacing
//      Allow for irregular slice dimensions (currently only allows square slices)
//      Proper scaling of image - current method is very unsophisticated
function CineRenderer(cineViewModel, canvas) {
    var self = this;

    // Inputs
    self.CineViewModel = cineViewModel; // view model for determining what to draw
    self.Canvas = canvas; // canvas for drawing on

    // Draws the slice to the canvas
    self.Draw = function () {
        var context = self.Canvas.getContext("2d");

        var canvasWidth = 450;
        var canvasHeight = 450;

        var slice = self.CineViewModel.CurrentSlice();
        var sliceData = slice.radiodensities;

        if (sliceData == null || sliceData.length == 0) {
            context.fillStyle = "#000000";
            context.fillRect(0, 0, canvasWidth, canvasHeight);

            return;
        }


        var imageData = context.createImageData(canvasWidth, canvasHeight);
        var data = imageData.data;

        var windowLevel = parseInt(self.CineViewModel.WindowLevel());
        var windowWidth = parseInt(self.CineViewModel.WindowWidth());

        for (var x = 0; x < canvasWidth; x++) {
            for (var y = 0; y < canvasHeight; y++) {
                // Get voxel data
                var sliceX = Math.round((slice.width / canvasWidth) * x);
                var sliceY = Math.round((slice.height / canvasHeight) * y);
                var sliceIndex = (sliceY * slice.height) + sliceX;

                // convert voxel to RGB via WLWW
                var rgbArray = VoxelToPixel(sliceData[sliceIndex], windowLevel, windowWidth);

                var index = ((y * canvasHeight) + x) * 4; // data is a byte array of RGBA values

                data[index] = rgbArray[0];
                data[index + 1] = rgbArray[1];
                data[index + 2] = rgbArray[2];
                data[index + 3] = 255; // always at 255 - no need for lower alpha
            }
        }

        context.putImageData(imageData, 0, 0);
    }

    self.CineViewModel.Volume.subscribe(self.Draw);
    self.CineViewModel.WindowWidth.subscribe(self.Draw);
    self.CineViewModel.WindowLevel.subscribe(self.Draw);
    self.CineViewModel.CurrentSlice.subscribe(self.Draw);

    self.Draw();
}

// Helper function for translating a HU value to a pixel value, via WL/WW
function VoxelToPixel(voxelValueHU, windowLevel, windowWidth) {
    var halfWidth = Math.round(windowWidth / 2);
    var lowerBound = windowLevel - halfWidth;
    var upperBound = windowLevel + halfWidth;

    if (voxelValueHU <= lowerBound)
        return [0, 0, 0];

    if (voxelValueHU >= upperBound)
        return [255, 255, 255];

    var range = upperBound - lowerBound;

    var val = Math.round(((voxelValueHU - lowerBound) / range) * 255);

    return [val, val, val];
}