var queryParams = require('./query-params');

function Compiler(editor, renderContracts, renderError, errortype, fileNameFromKey, fileKey, handleGithubCall, outputField, hidingRHP) {

  var compileJSON;
  var compilerAcceptsMultipleFiles;

  var previousInput = '';
  var sourceAnnotations = [];

  var cachedRemoteFiles = {};
  var worker = null;

  var compileTimeout = null;

  function onChange() {
    var input = editor.getValue();
    if (input === "") {
      window.localStorage.setItem(editor.getCacheFile(), '');
      return;
    }
    if (input === previousInput)
      return;
    previousInput = input;
    if (compileTimeout) window.clearTimeout(compileTimeout);
    compileTimeout = window.setTimeout(compile, 300);
  }

  editor.onChangeSetup(onChange);

  var compile = function(missingInputs) {
    editor.clearAnnotations();
    sourceAnnotations = [];
    outputField.empty();
    var input = editor.getValue();
    window.localStorage.setItem(editor.getCacheFile(), input);

    var files = {};
    files[fileNameFromKey(editor.getCacheFile())] = input;
    gatherImports(files, missingInputs, function(input, error) {
      outputField.empty();
      if (input === null) {
        renderError(error);
      } else {
        var optimize = queryParams.get().optimize;
        compileJSON(input, optimize ? 1 : 0);
      }
    });
  };
  this.compile = compile;

  this.addAnnotation = function(annotation) {
    sourceAnnotations[sourceAnnotations.length] = annotation;
    editor.setAnnotations(sourceAnnotations);
  };

  this.setCompileJSON = function() {
    compileJSON = function(source, optimize) { compilationFinished('{}'); };  
  };

  function onCompilerLoaded(setVersionText) {
    if (worker === null) {
      var compile;
      var missingInputs = [];
      if ('_compileJSONCallback' in Module) {
        compilerAcceptsMultipleFiles = true;
        var missingInputsCallback = Module.Runtime.addFunction(function(path, contents, error) {
          missingInputs.push(Module.Pointer_stringify(path));
        });
        var compileInternal = Module.cwrap("compileJSONCallback", "string", ["string", "number", "number"]);
        compile = function(input, optimize) {
          missingInputs.length = 0;
          return compileInternal(input, optimize, missingInputsCallback);
        };
      } else if ('_compileJSONMulti' in Module) {
        compilerAcceptsMultipleFiles = true;
        compile = Module.cwrap("compileJSONMulti", "string", ["string", "number"]);
      } else {
        compilerAcceptsMultipleFiles = false;
        compile = Module.cwrap("compileJSON", "string", ["string", "number"]);
      }
      compileJSON = function(source, optimize, cb) {
        try {
          var result = compile(source, optimize);
        } catch (exception) {
          result = JSON.stringify({error: 'Uncaught JavaScript exception:\n' + exception});
        }
        compilationFinished(result, missingInputs);
      };
      setVersionText(Module.cwrap("version", "string", [])());
    }
    previousInput = '';
    onChange();
  };
  this.onCompilerLoaded = onCompilerLoaded;

  function compilationFinished(result, missingInputs) {
    var data;
    var noFatalErrors = true; // ie warnings are ok

    try {
      data = JSON.parse(result);
    } catch (exception) {
      renderError('Invalid JSON output from the compiler: ' + exception);
      return;
    }

    if (data['error'] !== undefined) {
      renderError(data['error']);
      if (errortype(data['error']) !== 'warning') noFatalErrors = false;
    }
    if (data['errors'] != undefined) {
      data['errors'].forEach(function(err) {
        renderError(err);
        if (errortype(err) !== 'warning') noFatalErrors = false;
      });
    }

    if (missingInputs !== undefined && missingInputs.length > 0)
      this.compile(missingInputs);
    else if (noFatalErrors && !hidingRHP())
      renderContracts(data, editor.getValue());
  }

  this.initializeWorker = function(version, setVersionText) {
    if (worker !== null)
      worker.terminate();
    worker = new Worker('worker.js');
    worker.addEventListener('message', function(msg) {
      var data = msg.data;
      switch (data.cmd) {
      case 'versionLoaded':
        setVersionText(data.data);
        compilerAcceptsMultipleFiles = !!data.acceptsMultipleFiles;
        onCompilerLoaded(setVersionText);
        break;
      case 'compiled':
        compilationFinished(data.data, data.missingInputs);
        break;
      };
    });
    worker.onerror = function(msg) { console.log(msg.data); };
    worker.addEventListener('error', function(msg) { console.log(msg.data); });
    compileJSON = function(source, optimize) {
      worker.postMessage({cmd: 'compile', source: source, optimize: optimize});
    };
    worker.postMessage({cmd: 'loadVersion', data: 'https://ethereum.github.io/solc-bin/bin/' + version});
  };

  function gatherImports(files, importHints, cb) {
    importHints = importHints || [];
    if (!compilerAcceptsMultipleFiles)
    {
      cb(files[fileNameFromKey(editor.getCacheFile())]);
      return;
    }
    var importRegex = /^\s*import\s*[\'\"]([^\'\"]+)[\'\"];/g;
    var reloop = false;
    do {
      reloop = false;
      for (var fileName in files) {
        var match;
        while (match = importRegex.exec(files[fileName]))
          importHints.push(match[1]);
      }
      while (importHints.length > 0) {
        var m = importHints.pop();
        if (m in files) continue;
        if (editor.getFiles().indexOf(fileKey(m)) !== -1) {
          files[m] = window.localStorage[fileKey(m)];
          reloop = true;
        } else if (m.startsWith('./') && editor.getFiles().indexOf(fileKey(m.slice(2))) !== -1) {
          files[m] = window.localStorage[fileKey(m.slice(2))];
          reloop = true;
        } else if (m in cachedRemoteFiles) {
          files[m] = cachedRemoteFiles[m];
          reloop = true;
        } else if (githubMatch = /^(https?:\/\/)?(www.)?github.com\/([^\/]*\/[^\/]*)\/(.*)/.exec(m)) {
          handleGithubCall(function(result) {
            if ('content' in result)
            {
              var content = Base64.decode(result.content);
              cachedRemoteFiles[m] = content;
              files[m] = content;
              gatherImports(files, importHints, cb);
            }
            else
              cb(null, "Unable to import \"" + m + "\"");
          }).fail(function(){
            cb(null, "Unable to import \"" + m + "\"");
          });
          return;
        } else {
          cb(null, "Unable to import \"" + m + "\"");
          return;
        }
      }
    } while (reloop);
    cb(JSON.stringify({'sources':files}));
  }
}

module.exports = Compiler
