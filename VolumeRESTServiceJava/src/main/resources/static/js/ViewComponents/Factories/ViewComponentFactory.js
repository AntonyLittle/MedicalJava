//
// Factory class for creating view components. Currently only creates the cine view component.

function ViewComponentFactory() {
    var self = this;

    // Creates a Cine view component, with a cine and wl/ww tool
    self.CreateCineViewComponent = function (cineViewModel, canvas) {
        var viewComponent = new BasicViewComponent();
        viewComponent.Renderer = new CineRenderer(cineViewModel, canvas);

        viewComponent.Tools.push(new WLWWTool(cineViewModel.WindowLevel, cineViewModel.WindowWidth, canvas.width / 2000, canvas.height / 1000));
        viewComponent.Tools.push(new CineTool(cineViewModel, canvas.height / 100));

        viewComponent.Bind(canvas);
    }
}