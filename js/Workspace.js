'use strict';

define([
    'colormaps', 'eventsource', 'imageloader', 'inputfilesprocessor', 'materialloader', 'scene2d', 'scene3d', 'three'
],
function(ColorMap, EventSource, ImageLoader, InputFilesProcessor, MaterialLoader, Scene2D, Scene3D, THREE) {
    /**
     * Main application workspace. It works in 3 modes:
     * 1. UNDEFINED. In may have measures but with no visual representation.
     * 2. MODE_2D. It has image. Spots are mapped on this image using X and Y
     *    coordinates (Z ignored).
     * 3. MODE_3D. It has a THREE.js scene with a mesh, light souces ets.
     *
     * Workspace tracks changes in measures, images and meshes and fires appropriates
     * events to allow updates. Workspace may have multiple views (2D and 3D view
     * shouldn't be mixed). Different 3D view for instance may show the same scene
     * from different perspectives.
     *
     * 'status'/'status-change' intended to inform
     * the user on progress in long-running tasks.
     *
     * 'measures'/'intensities-change' lets to update the map-list.
     */
    function Workspace() {
        EventSource.call(this, Workspace.Events);

        this._mode = Workspace.Mode.UNDEFINED;
        this._errors = [];
        this._spots = null;
        this._mapping = null;
        this._measures = null;
        this._activeMeasure = null;
        this._colorMap = ColorMap.Maps.VIRIDIS;
        this._scale = Workspace.Scale.LINEAR;
        this._hotspotQuantile = 1.0;
        this._autoMinMax = true;
        this._minValue = 0.0;
        this._maxValue = 0.0;
        this._scene3d = new Scene3D();
        this._scene2d = new Scene2D();
        this._currentScene = null;
        this._scene3d.colorMap = this._colorMap;
        this._scene2d.colorMap = this._colorMap;
        this._loadedSettings = null;
        this._inputFilesProcessor = new InputFilesProcessor(this);

        this._status = '';
        this._tasks = {};
        this._settingsToLoad = null;

        this.addEventListener(Workspace.Events.NO_TASKS, this._loadPendingSettings.bind(this));
    }

    Workspace.Events = {
        STATUS_CHANGE: 'status-change',
        MODE_CHANGE: 'mode-change',
        MAPPING_CHANGE: 'mapping-change',
        INTENSITIES_CHANGE: 'intensities-change',
        ERRORS_CHANGE: 'errors-change',
        AUTO_MAPPING_CHANGE: 'auto-mapping-change',
        SETTINGS_CHANGE: 'settings-change',
        NO_TASKS: 'no-tasks'
    }

    Workspace.Mode = {
        UNDEFINED: 1,
        MODE_2D: 2,
        MODE_3D: 3,
    };

    Workspace.Scale = {
        LOG: {
            id: 'log',
            function: Math.log10,
            filter: function(x) {
                return x > 0.0 && x < Infinity;
            },
            legend: 'log',
        },

        LINEAR: {
            id: 'linear',
            function: function(x) {
                return x;
            },
            filter: function(x) {
                return x > -Infinity && x < Infinity;
            },
            legend: '',
        }
    };

    Workspace.getScaleById = function(id) {
        for (var i in Workspace.Scale) {
            if (Workspace.Scale[i].id == id) return Workspace.Scale[i];
        }
        throw 'Invalid scale id: ' + id;
    };

    /**
     * Asynchromous tasks. At most one task with the same key may run
     * (no 2 images could be loading simultaniously). Newer task cancels older one.
     * 'worker' is name of JS file in 'js/workers' or constructor of a Worker-like
     * class.
     */
    Workspace.TaskType = {
        DOWNLOAD: {
            key: 'download',
            worker: 'Downloader.js'
        },

        LOAD_IMAGE: {
            key: 'load-image',
            worker: ImageLoader
        },

        LOAD_MESH: {
            key: 'load-mesh',
            worker: 'MeshLoader.js'
        },

        LOAD_MATERIAL: {
            key: 'load-material',
            worker: MaterialLoader
        },

        LOAD_MEASURES: {
            key: 'load-measures',
            worker: 'MeasuresLoader.js'
        },

        LOAD_SETTINGS: {
            key: 'load-settings',
            worker: 'SettingsLoader.js'
        },

        MAP: {
            key: 'map',
            worker: 'Mapper.js'
        },
    };

    Workspace._createCurrentSceneProperty = function(prop, postModificationCallback) {
        return {
            get: function () {
                if (!this._currentScene) {
                    console.log('Data is not loaded');
                } else {
                    return this._currentScene[prop];
                }
            },
            set: function (value) {
                if (!this._currentScene) {
                    console.log('Data is not loaded');
                } else {
                    this._currentScene[prop] = value;
                    if (postModificationCallback) {
                        postModificationCallback.bind(this)();
                    }
                }
            }
        };
    };

    Workspace._createSpotsProperty = function (getter, setter, postModificationCallback) {
        if (typeof getter === 'string') {
            var getName = getter;
            getter = function (spot) {
                return spot[getName];
            }
        } else if (!(getter instanceof Function)) {
            throw 'Scene property specifier must be function or string';
        }

        if (typeof setter === 'string') {
            var setName = setter;
            setter = function (spot, values) {
                return spot[setName] = values[spot.name][setName];
            }
        } else if (!(setter instanceof Function)) {
            throw 'Scene property specifier must be function or string';
        }

        return {
            get: function () {
                var result = {};
                var spots = this._currentScene ? this._currentScene.spots : this._spots;
                if (!spots) {
                    return result;
                }
                for (var i = 0; i < spots.length; ++i) {
                    var spot = spots[i];
                    result[spot.name] = getter(spot);
                }
                return result;
            },
            set: function (values) {
                if (!this._spots) {
                    return;
                }
                for (var i = 0; i < this._spots.length; ++i) {
                    var spot = this._spots[i];
                    if (spot.name in values) {
                        setter(spot, values);
                        if (this._currentScene) {
                            setter(this._currentScene.spots[i], values);
                        }
                    }
                }
                if (postModificationCallback) {
                    postModificationCallback.bind(this)();
                } else if (this._currentScene) {
                    this._currentScene.refreshSpots();
                }
            }
        };
    };

    Workspace._onSpotScaleChange = function () {
        if (this.mode == Workspace.Mode.MODE_3D) {
            this._mapMesh(Scene3D.RecoloringMode.NO_COLORMAP);
        } else if (this.mode == Workspace.Mode.MODE_2D) {
            this._scene2d.refreshSpots();
        }
    };

    Workspace.prototype = Object.create(EventSource.prototype, {
        /**
         * Switches the workspace to MODE_2D and starts image loading.
         */
        loadImage: {
            value: function(blob) {
                this.mode = Workspace.Mode.MODE_2D;

                this._scene2d.resetImage();
                this._doTask(Workspace.TaskType.LOAD_IMAGE, blob[0]).
                    then(function(result) {
                        this._scene2d.setImage(result.url, result.width, result.height);
                    }.bind(this));
            }
        },

        /**
         * Switches the workspace to MODE_3D and starts mesh loading.
         */
        loadMesh: {
            value: function(blob) {
                this.mode = Workspace.Mode.MODE_3D;

                this._doTask(Workspace.TaskType.LOAD_MESH, blob[0]).then(function(result) {
                    var geometry = new THREE.BufferGeometry();
                    for (var name in result.attributes.geometry) {
                        var attribute = result.attributes.geometry[name];
                        geometry.addAttribute(name, new THREE.BufferAttribute(
                            attribute.array, attribute.itemSize));
                    }
                    this._scene3d.materialName = result.attributes.materialName;
                    this._scene3d.geometry = geometry;
                    if (this._spots) {
                        this._scene3d.spots = this._spots;
                        this._mapMesh(Scene3D.RecoloringMode.USE_COLORMAP);
                    }
                }.bind(this));
            }
        },

        loadMaterial: {
            value: function (blob) {
                this.mode = Workspace.Mode.MODE_3D;

                this._doTask(Workspace.TaskType.LOAD_MATERIAL, blob).then(function (result) {
                    this._scene3d.materials = result.materials;
                }.bind(this));
            }
        },

        /**
         * Starts loading intensities file.
         */
        loadIntensities: {
            value: function(blob) {
                this._doTask(Workspace.TaskType.LOAD_MEASURES, blob[0]).
                    then(function (result) {
                        this._spots = result.spots.map(function (spot) {
                            spot.scale = 1.0;
                            spot.color = new THREE.Color();
                            spot.visibility = 1.0;
                            return spot;
                        });
                        this._measures = result.measures;
                        this._activeMeasure = null;
                        if (this._mode == Workspace.Mode.MODE_3D) {
                            this._scene3d.spots = this._spots;
                            this._mapMesh(Scene3D.RecoloringMode.USE_COLORMAP);
                        } else if (this._mode == Workspace.Mode.MODE_2D) {
                            this._scene2d.spots = this._spots;
                        }
                        this._notify(Workspace.Events.INTENSITIES_CHANGE);
                    }.bind(this));
            }
        },

        loadSettings: {
            value: function (blob) {
                this._settingsToLoad = blob[0];
                this._loadPendingSettings();
            }
        },

        loadFiles: {
            value: function(files) {
                this._inputFilesProcessor.process(files);
            }
        },

        download: {
            value: function(fileNames) {
                if (!fileNames) return;

                fileNames = fileNames.filter(function(name) {
                    return name != '';
                });
                if (!fileNames.length) {
                    return;
                }

                this._doTask(Workspace.TaskType.DOWNLOAD, fileNames).
                    then(function (result) {
                        this.loadFiles(result.items);
                    }.bind(this));
            }
        },

        /*
         * @param {index} Index in the this.measures list.
         */
        selectMapByIndex: {
            value: function(index) {
                if (!this._measures) return;

                this._activeMeasure = this._measures[index];
                if (this._autoMinMax) this._updateMinMaxValues();
                this._updateIntensities();
            }
        },

        mapName: {
            get: function() {
                return this._activeMeasure ? this._activeMeasure.name : '';
            }
        },

        spotVisibility: Workspace._createSpotsProperty('visibility', function (spot, visibility) {
            var v = visibility[spot.name];
            v = v < 0 ? 0 : v > 1 ? 1 : v;
            spot.visibility = v;
        }),

        spotColors: Workspace._createSpotsProperty(function (spot) {
            return spot.color.getHexString();
        }, function (spot, colors) {
            spot.color = new THREE.Color(colors[spot.name]);
        }),

        spotScale: Workspace._createSpotsProperty('scale', function (spot, scale) {
            var s = scale[spot.name];
            s = s < 0 ? 0 : s;
            spot.scale = s;
        }, Workspace._onSpotScaleChange),

        globalSpotScale: Workspace._createCurrentSceneProperty('globalSpotScale', Workspace._onSpotScaleChange),

        autoMinMax: {
            get: function() {
                return this._autoMinMax;
            },

            set: function(value) {
                this._autoMinMax = !!value;
                if (this._autoMinMax) {
                    this._updateMinMaxValues() && this._updateIntensities();
                }
                this._notify(Workspace.Events.AUTO_MAPPING_CHANGE);
            }
        },

        minValue: {
            get: function() {
                return this._minValue;
            },

            set: function(value) {
                if (this._autoMinMax) return;
                this._minValue = Number(value);
                this._updateIntensities();
                this._notify(Workspace.Events.MAPPING_CHANGE);
            }
        },

        maxValue: {
            get: function() {
                return this._maxValue;
            },

            set: function(value) {
                if (this._autoMinMax) return;
                this._maxValue = Number(value);
                this._updateIntensities();
                this._notify(Workspace.Events.MAPPING_CHANGE);
            }
        },

        errors: {
            get: function() {
                return this._errors;
            }
        },

        clearErrors: {
            value: function() {
                this._errors = [];
                this._notify(Workspace.Events.ERRORS_CHANGE);
            }
        },

        _addError: {
            value: function(message) {
                this._errors.push(message);
                this._notify(Workspace.Events.ERRORS_CHANGE);
            }
        },

        /**
         * Prepares this._mapping for fast recoloring the mesh.
         */
        _mapMesh: {
            value: function(recoloringMode) {
                if (!this._scene3d.geometry || !this._spots) return;
                var args = {
                    vertices: this._scene3d.geometry.getAttribute('position').array,
                    spots: this._spots,
                    scale: this._scene3d.globalSpotScale
                };
                this._doTask(Workspace.TaskType.MAP, args).then(function(results) {
                    this._scene3d.mapping = {
                        closestSpotIndeces: results.closestSpotIndeces,
                        closestSpotDistances: results.closestSpotDistances,
                        recoloringMode: recoloringMode
                    };
                }.bind(this));
            }
        },

        _cancelTask: {
            value: function(taskType) {
                if (taskType.key in this._tasks) {
                    this._tasks[taskType.key].worker.terminate();
                    delete this._tasks[taskType.key];
                }
                if (Object.keys(this._tasks).length < 1) {
                    this._notify(Workspace.Events.NO_TASKS);
                }
            }
        },

        _loadPendingSettings: {
            value: function () {
                if (Object.keys(this._tasks).length < 1 && this._settingsToLoad !== null) {
                    this._doTask(Workspace.TaskType.LOAD_SETTINGS, this._settingsToLoad).
                        then(function (result) {
                            this._loadedSettings = result.settings;
                            this._notify(Workspace.Events.SETTINGS_CHANGE);
                        }.bind(this));
                    this._settingsToLoad = null;
                }
            }
        },

        /**
         * Starts a new task (cancels an old one it it's running).
         *
         * @param {Workspace.TaskType} taskType Task to run.
         * @param {Object} args Arguments to post to the task's worker.
         * @return {Promise}
         **/
        _doTask: {
            value: function(taskType, args) {
                if (taskType.key in this._tasks) this._cancelTask(taskType);

                var task = {
                    worker: typeof taskType.worker == 'function' ?
                        new taskType.worker() :
                        new Worker('js/workers/' + taskType.worker),
                    status: '',
                    cancel: this._cancelTask.bind(this, taskType),
                    startTime: new Date().valueOf(),
                };
                this._tasks[taskType.key] = task;
                var setStatus = this._setStatus.bind(this);
                var addError = this._addError.bind(this);

                if (typeof taskType.worker == 'function') {
                    task.worker.postMessage(args);
                }
                return new Promise(function(resolve, reject) {
                    task.worker.onmessage = function(event) {
                        switch (event.data.status) {
                            case 'completed':
                                setStatus('');
                                resolve(event.data);
                                task.cancel();
                                console.info('Task ' + taskType.key + ' completed in ' +
                                    (new Date().valueOf() - task.startTime) /
                                    1000 + ' sec');
                                break;
                            case 'failed':
                                reject(event.data);
                                task.cancel();
                                setStatus('');
                                addError('Operation failed: ' + event.data.message);
                                break;
                            case 'working':
                                setStatus(event.data.message);
                                break;
                            case 'ready':
                                this.postMessage(args);
                                break;
                        };
                    };
                    task.worker.onerror = function(event) {
                        setStatus('');
                        addError('Operation failed. See log for details.');
                    }.bind(this);
                }.bind(this));
            }
        },

        _updateMinMaxValues: {
            value: function() {
                var values = this._activeMeasure ? this._activeMeasure.values : [];

                var values = Array.prototype.filter.call(values, this._scale.filter).sort(function(a, b) {
                    return a - b;
                });

                var minValue = values.length > 0 ? this._scale.function(values[0]) : 0.0;
                var maxValue = values.length > 0 ?
                    this._scale.function(values[Math.ceil((values.length - 1) *
                        this._hotspotQuantile)]) :
                    0.0;

                if (this._minValue != minValue || this._maxValue != maxValue) {
                    this._minValue = minValue;
                    this._maxValue = maxValue;
                    this._notify(Workspace.Events.AUTO_MAPPING_CHANGE);
                    this._notify(Workspace.Events.MAPPING_CHANGE);
                    return true;
                } else {
                    return false;
                }
            }
        },

        _updateIntensities: {
            value: function() {
                if (!this._spots) return;

                for (var i = 0; i < this._spots.length; i++) {
                    var scaledValue = this._activeMeasure &&
                        this._scale.function(this._activeMeasure.values[i]);
                    var intensity = NaN;

                    if (scaledValue >= this._maxValue) {
                        intensity = 1.0;
                    } else if (scaledValue >= this._minValue) {
                        intensity = (scaledValue - this._minValue) / (this._maxValue - this._minValue);
                    }
                    this._spots[i].intensity = intensity;
                }
                this._scene3d.updateIntensities(this._spots);
                this._scene2d.updateIntensities(this._spots);
            }
        },

        _setStatus: {
            value: function(status) {
                this._status = status;
                this._notify(Workspace.Events.STATUS_CHANGE);
            }
        },

        mode: {
            get: function() {
                return this._mode;
            },

            set: function(value) {
                if (this._mode == value) {
                    return;
                }
                this._mode = value;

                if (this._mode == Workspace.Mode.MODE_2D) {
                    this._scene2d.spots = this._spots;
                    this._currentScene = this._scene2d;
                } else {
                    this._scene2d.resetImage();
                    this._scene2d.spots = null;
                    this._cancelTask(Workspace.TaskType.LOAD_IMAGE);
                }
                if (this._mode == Workspace.Mode.MODE_3D) {
                    this._scene3d.spots = this._spots;
                    this._currentScene = this._scene3d;
                } else {
                    this._scene3d.geometry = null;
                    this._scene3d.spots = null;
                    this._cancelTask(Workspace.TaskType.LOAD_MESH);
                }

                this._notify(Workspace.Events.MODE_CHANGE);
            }
        },

        scene2d: {
            get: function() {
                return this._scene2d;
            }
        },

        scene3d: {
            get: function() {
                return this._scene3d;
            }
        },

        status: {
            get: function() {
                return this._status;
            }
        },

        measures: {
            get: function() {
                return this._measures || [];
            }
        },

        hotspotQuantile: {
            get: function() {
                return this._hotspotQuantile;
            },

            set: function(value) {
                if (this._hotspotQuantile == value) return;
                if (value < 0.0) value = 0.0;
                if (value > 1.0) value = 1.0;
                this._hotspotQuantile = value;
                if (this._autoMinMax) {
                    this._updateMinMaxValues() && this._updateIntensities();
                }
            }
        },

        spotBorder: {
            get: function() {
                return this._currentScene ? this._currentScene.spotBorder : undefined;
            },

            set: function (value) {
                if (this._currentScene) {
                    this._currentScene.spotBorder = value;
                }
            }
        },

        scale: {
            get: function() {
                return this._scale;
            }
        },

        scaleId: {
            get: function() {
                return this._scale.id;
            },

            set: function(value) {
                if (this._scale.id == value) return;
                this._scale = Workspace.getScaleById(value);
                if (this._autoMinMax) this._updateMinMaxValues();
                this._updateIntensities();
                this._notify(Workspace.Events.MAPPING_CHANGE);
            }
        },

        colorMap: {
            get: function() {
                return this._colorMap;
            }
        },

        colorMapId: {
            get: function() {
                for (var i in ColorMap.Maps) {
                    if (this._colorMap === ColorMap.Maps[i]) return i;
                }

            },

            set: function(value) {
                if (value in ColorMap.Maps) {
                    this._colorMap = ColorMap.Maps[value];
                    this._scene2d.colorMap = this._colorMap;
                    this._scene3d.colorMap = this._colorMap;
                    this._notify(Workspace.Events.MAPPING_CHANGE);
                }
            }
        },

        loadedSettings: {
            get: function () {
                return this._loadedSettings;
            }
        }
    });

    return Workspace;
});
