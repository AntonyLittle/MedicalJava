//
// Main ViewModel for our single-page app.
//
function ViewModel() {
    var self = this;

    // AJAX request objects (XMLHttpRequest), so we can abort incomplete requests
    self.PatientsLoadingXHR = null;
    self.PatientVolumesLoadingXHR = null;
    self.CurrentVolumeLoadingXHR = null;

    // Loading statuses (ko observables)
    self.ArePatientsLoading = ko.observable(false);
    self.ArePatientVolumesLoading = ko.observable(false);
    self.IsCurrentVolumeLoading = ko.observable(false);

    // Array of available patients
    self.Patients = ko.observableArray();

    // The selected patient summary
    self.CurrentPatient = ko.observable();
    self.SelectCurrentPatient = function (patient) {

        // Are we already loading somethings? Cancel if we are...
        if (self.PatientVolumesLoadingXHR != null)
            self.PatientVolumesLoadingXHR.abort();

        if (patient == null) {
            self.CurrentPatient({ patientId: -1, name: "<No patient selected>", volumes: [] });
            return;
        }

        self.CurrentPatient(patient);
        self.CurrentPatientVolumes([]);
        self.SelectCurrentVolume(null);

        // Mark as loading and load the relevant volumes
        self.ArePatientVolumesLoading(true);
        self.PatientVolumesLoadingXHR = MakeAjaxJSONRequest(
            self._url + "/" + patient.patientId + "/Volumes",
            function (data) {
                self.CurrentPatientVolumes(data);
            },
            function () {
                self.ArePatientVolumesLoading(false);
                self.PatientVolumesLoadingXHR = null;
            }
        );
    }

    // Selected patients volume summaries
    self.CurrentPatientVolumes = ko.observableArray();

    // Selected volume
    self.CurrentVolume = ko.observable();
    self.SelectCurrentVolume = function (volume) {

        // Are we already loading somethings? Cancel if we are...
        if (self.CurrentVolumeLoadingXHR != null)
            self.CurrentVolumeLoadingXHR.abort();

        if (volume == null) {
            self.CurrentVolume({ patientId: -1, volumeId: -1, name: "<No volume selected>", slices: [] });
            return;
        }

        self.CurrentVolume(volume);

        // Mark as loading and load the relevant volumes
        self.IsCurrentVolumeLoading(true);
        self.CurrentVolumeLoadingXHR = MakeAjaxJSONRequest(
            self._url + "/" + volume.patientId + "/Volumes/" + volume.volumeId,
            function (data) {
                self.CurrentVolume(data);
            },
            function () {
                self.IsCurrentVolumeLoading(false);
                self.CurrentVolumeLoadingXHR = null;
            }
        );
    }

    // Server data loading
    self._url = "";
    self.SetURL = function (url) {
        this._url = url;
    }

    self.LoadPatients = function () {
        // Clear the existing patients list
        self.Patients.removeAll();
        self.CurrentPatientVolumes.removeAll();
        self.SelectCurrentPatient(null);
        self.SelectCurrentVolume(null);

        // Are we already loading somethings? Cancel if we are...
        if (self.PatientsLoadingXHR != null)
            self.PatientsLoadingXHR.abort();

        // Mark as loading and initiate the loading
        self.ArePatientsLoading(true);
        self.PatientsLoadingXHR = MakeAjaxJSONRequest(
            this._url,
            function (data) {
                self.Patients(data);
            },
            function () {
                self.ArePatientsLoading(false);
                self.PatientsLoadingXHR = null;
            }
        );
    }

    self.SelectCurrentPatient(null);
    self.SelectCurrentVolume(null);


    // Sub-view models for rendered views
    self.CineViewModel = new CineViewModel(self.CurrentVolume);
}

// Helper function for making a cancelable AJAX request
function MakeAjaxJSONRequest(requestUrl, callbackSuccess, callbackAlways) {
    return $.ajax({
        url: requestUrl,
        dataType: "json",
        success: callbackSuccess,
        complete: callbackAlways
    });
}