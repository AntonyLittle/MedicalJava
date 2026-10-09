//
// View model for the Cine view component. Aggregated by the main ViewModel class.
//
function CineViewModel(observableVolume) {
    var self = this;

    // Inherit from the WLWW model - I'd prefer this as a property, but the observe/notify chain details elude me for now.
    WindowLevelAndWidthViewModel.call(this);

    // The current volume
    self.Volume = observableVolume;

    // The index of the currently viewed slice
    self.CurrentSliceIndex = ko.observable(0);
    self.ChangeCurrentSliceIndex = function (newSliceIndex) {
        if (newSliceIndex >= self.Volume().slices.length)
            newSliceIndex = self.Volume().slices.length - 1;

        if (newSliceIndex < 0)
            newSliceIndex = 0;

        self.CurrentSliceIndex(newSliceIndex);
    };

    // The currently viewed slice, as defined by the volume and CurrentSliceIndex
    self.CurrentSlice = ko.computed(
        function () {
            if (self.CurrentSliceIndex() >= self.Volume().slices.length) {
                self.CurrentSliceIndex(0);
            }

            if (self.Volume().slices.length == 0) {
                var dummySlice = { sliceId: -1, volumeId: -1, patientId: -1, index: -1, width: 0, weight: 0, radiodensities: [] };
                return dummySlice;
            }

            var slice = self.Volume().slices[self.CurrentSliceIndex()];

            return slice;
        }
    );
}