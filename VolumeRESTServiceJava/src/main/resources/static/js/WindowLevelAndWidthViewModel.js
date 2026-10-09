//
// View model for Wl/WW. Aggregated by CineViewModel (and later any view model with a WL/WW)
//
function WindowLevelAndWidthViewModel() {
    var self = this;

    // The window level/width
    self.WindowWidth = ko.observable(2000);
    self.WindowLevel = ko.observable(1000);
}