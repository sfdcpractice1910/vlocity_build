var jsforce = require('jsforce');
var yaml = require('js-yaml');
var fs = require('fs-extra');
var path = require('path');
var stringify = require('json-stable-stringify');
var childProcess = require('child_process');
var sfdx = require('salesforce-alm');

const VLOCITY_NAMESPACE = '%vlocity_namespace%';

var UtilityService = module.exports = function(vlocity) {
    this.vlocity = vlocity || {};
};

UtilityService.prototype.replaceAll = function(str, find, replace) {
    return str.replace(new RegExp(find, 'g'), replace);
};

UtilityService.prototype.setNamespaceToOrg = function(value) {
    return JSON.parse(JSON.stringify(value).replace(new RegExp(VLOCITY_NAMESPACE, 'g'), this.vlocity.namespace));
};

UtilityService.prototype.setNamespaceToDefault = function(value) {

    if (!value) return value;

    return JSON.parse(JSON.stringify(value).replace(new RegExp(this.vlocity.namespace, 'g'), VLOCITY_NAMESPACE));
};

UtilityService.prototype.buildHashMap = function(fields, records) {
    var fieldsValuesMap = {};

    for (var i = 0; i < records.length; i++) {
        for (var key in fields) {
            if (records[i].hasOwnProperty(key)) {
                var uniqueKey = key + records[i][key];
                uniqueKey = uniqueKey.toLowerCase();
                
                if (!fieldsValuesMap[uniqueKey]) {
                    fieldsValuesMap[uniqueKey] = [];
                    fieldsValuesMap[uniqueKey].field = key;
                    fieldsValuesMap[uniqueKey].value = records[i][key];
                }
                
                fieldsValuesMap[uniqueKey].push(records[i]);
            }
        }
    }

    return fieldsValuesMap;
};

UtilityService.prototype.getDataPackData = function(dataPack) {
    if (dataPack) {
        for (var key in dataPack.VlocityDataPackData) {
            if (dataPack.VlocityDataPackData[key] 
                && dataPack.VlocityDataPackData[key] instanceof Array) {
                    return dataPack.VlocityDataPackData[key][0];
                }
        }
    }

    return {};
};

UtilityService.prototype.isEmptyObject = function(obj) {
    for (var name in obj) {
        return false;
    }
    return true;
};

UtilityService.prototype.mergeMaps = function(firstMap, secondMap) {
    for (var key in secondMap) {
        firstMap[key] = secondMap[key];
    }

    return firstMap;
};

UtilityService.prototype.createCustomMetadataRecord = async function(metadata) {
    
    if (metadata && !this.vlocity.utilityservice.isEmptyObject(metadata)) {
        metadata = this.setNamespaceToOrg(metadata);

        try {
            return await this.vlocity.jsForceConnection.metadata.create('CustomMetadata', metadata, function(err, results) {
                if (results) {
                    if (!(results instanceof Array)) {
                        results = [results];
                    }
        
                    for (var result of results) {
                        if (results && !result.success) {
                            VlocityUtils.error('Create Failed', result.errors);
                        }
                    }
        
                    VlocityUtils.verbose('Create Custom Metadata Record', results);
                    return results;
                }
            });
        } catch (e) {
            VlocityUtils.error('Create Failed', e.message);
        }
    }
};

UtilityService.prototype.getVlocityDataPackConfigurations = async function() {
    var resultMap = {};

    var queryResult = await this.vlocity.queryservice.query('SELECT Id,DeveloperName,NamespacePrefix FROM %vlocity_namespace%__VlocityDataPackConfiguration__mdt');

    if (queryResult && queryResult.records) {
        var records = this.setNamespaceToDefault(queryResult.records);

        for (var i = 0; i < records.length; i++) {
            var fieldName = records[i]['DeveloperName'];

            if (resultMap[fieldName]) {
                if (records[i]['NamespacePrefix'] !== null) {
                    continue;
                }
            }

            resultMap[fieldName] = records[i];
        }
    }

    return resultMap;
};

UtilityService.prototype.getDRMatchingKeys = async function() {
    var resultMap = {};

    var queryResult = await this.vlocity.queryservice.query('SELECT Id,Label,NamespacePrefix,%vlocity_namespace%__ObjectAPIName__c,%vlocity_namespace%__MatchingKeyFields__c FROM %vlocity_namespace%__DRMatchingKey__mdt');

    if (queryResult && queryResult.records) {
        var records = this.setNamespaceToDefault(queryResult.records);

        for (var i = 0; i < records.length; i++) {
            var fieldName = records[i]['%vlocity_namespace%__ObjectAPIName__c'];

            if (resultMap[fieldName]) {
                if (records[i]['NamespacePrefix'] !== null) {
                    continue;
                }
            }

            resultMap[fieldName] = records[i];
        }
    }

    return resultMap;
};

UtilityService.prototype.getDRMatchingKeyFields = async function() {
    var result = await this.getDRMatchingKeys();

    for (var objectName in result) {
        result[objectName] = result[objectName]['%vlocity_namespace%__MatchingKeyFields__c'].split(',');
    }

    return result;
};

UtilityService.prototype.runInputMap = async function(inputList, status, allLimitPromiseThreads) {
    try {
        while (inputList.length > 0 && !status.cancel) {
            var inputMap = inputList.shift();
            await inputMap.context[inputMap.func](inputMap.argument);
        }
    } catch (e) {
        status.cancel = true;
        status.errors.push(e);
    }
}

UtilityService.prototype.parallelLimit = async function(inputList, limit = 50) {

    var allLimitPromiseThreads = [];
    var status = { cancel: false, errors: [] };

    for (var i = 0; i < limit; i++) {
        allLimitPromiseThreads.push(this.runInputMap(inputList, status, allLimitPromiseThreads));
    }

    do {
        try {
            await Promise.all(allLimitPromiseThreads);
        } catch (e) {
            status.errors.push(e);
        }
    } while (inputList.length > 0 && !status.cancel) 

    if (status.errors.length > 0) {
        throw status.errors;
    }
};

UtilityService.prototype.forceFinish = async function(inFlight, errors) {
    try {
        await Promise.all(inFlight);
    } catch (e) {
        errors.push(e);
        await this.forceFinish(inFlight, errors);
    }
}

UtilityService.prototype.createSObject = async function(sObjectType, sObject) {
    return await this.vlocity.jsForceConnection.sobject(sObjectType).create(sObject);
};

UtilityService.prototype.loginFailedMessage = function(error) {
    return 'Login Failed - Username: ' + (this.vlocity.username ? (this.vlocity.username + ' ') : 'None Provided') + ' Error ' + error;
}

UtilityService.prototype.login = async function(retryCount) {
    
    try {
        var result = await this.vlocity.jsForceConnection.login(this.vlocity.username, this.vlocity.password);

        this.organizationId = result.organizationId;
    } catch (err) {
        if (!retryCount || retryCount < 5) {
            VlocityUtils.error('Login Failed', 'Retrying', this.loginFailedMessage(err));
            await this.login(retryCount ? ++retryCount : 1);
        } else {
            throw this.loginFailedMessage(err);
        }
    }
}

UtilityService.prototype.sfdxLogin = async function() {
    VlocityUtils.report('Using SFDX', this.vlocity.sfdxUsername);

    try {
        var stored = JSON.parse(fs.readFileSync(path.join(this.vlocity.tempFolder, 'sfdx', this.vlocity.sfdxUsername + '.json')));

        this.vlocity.jsForceConnection = new jsforce.Connection(stored);

        var identity = await this.vlocity.jsForceConnection.identity();
        
        if (identity.username == stored.username) {
            VlocityUtils.report('Using SFDX Session');

            this.vlocity.organizationId = identity.organization_id;
            return stored;
        }

    } catch (e) {
        VlocityUtils.verbose('Session Not Found');
    }

    VlocityUtils.report('Refreshing SFDX Session', this.vlocity.sfdxUsername);

    let orgInfo = await this.sfdx('org:display', { targetusername: this.vlocity.sfdxUsername });

    if (orgInfo) {
        this.vlocity.organizationId = orgInfo.id;

        this.vlocity.jsForceConnection = new jsforce.Connection(orgInfo);

        try {
            fs.outputFileSync(path.join(this.vlocity.tempFolder, 'sfdx', this.vlocity.sfdxUsername + '.json'), JSON.stringify(orgInfo,null, 4));
        } catch (e) {
            VlocityUtils.error('Error Saving SFDX Credentials', e);
        }
       
        return orgInfo;
    } else {
        throw this.loginFailedMessage('Salesforce DX Org Info Not Found');
    }   
}

UtilityService.prototype.checkLogin = async function() {
    
    VlocityUtils.verbose('Check Login');

    if (this.vlocity.sessionId || this.vlocity.accessToken) {
        await this.getNamespace();
    } else if (this.vlocity.sfdxUsername) {
        await this.sfdxLogin();
        await this.getNamespace();
    } else if (this.vlocity.username && this.vlocity.password) {
        await this.login();
        await this.getNamespace();
    } else {
        if (this.vlocity.passedInNamespace) {
            this.vlocity.namespace = this.vlocity.passedInNamespace;
        } else {
            this.vlocity.namespace = 'NoNamespace';
        }

        VlocityUtils.verbose('Update Definitions');

        this.vlocity.datapacksutils.dataPacksExpandedDefinition = this.vlocity.datapacksutils.updateExpandedDefinitionNamespace(this.vlocity.datapacksutils.dataPacksExpandedDefinition);
        
        this.vlocity.PackageVersion = 'No Login';
        this.vlocity.BuildToolSettingVersion = "latest";
    }
};

UtilityService.prototype.getNamespace = async function() {
    
    VlocityUtils.verbose('Get Namespace');

    if (!this.vlocity.namespace) {
        var result;
        try {
            result = await this.vlocity.jsForceConnection.query("Select Name, NamespacePrefix from ApexClass where Name = 'DRDataPackService'");
        } catch (err) {
            if (this.vlocity.passedInNamespace) {
                return;
            } else if (err.code == 'ECONNRESET') {
                await this.getNamespace();
            } else {
                throw 'Namespace Query ' + err;
            }
        }
    
        if (result && result.records && result.records.length > 0) {
            this.vlocity.namespace = result.records[0].NamespacePrefix;
        }

        if (!this.vlocity.namespace && this.vlocity.passedInNamespace) {
            this.vlocity.namespace = this.vlocity.passedInNamespace;
        }

        if (this.vlocity.namespace == null) {
            throw `Vlocity Managed Package Not Found in Org: ${this.vlocity.username}`;
        } 
        
        VlocityUtils.namespace = this.vlocity.namespace;

        this.vlocity.namespacePrefix = this.vlocity.namespace ? this.vlocity.namespace + '__' : '';

        VlocityUtils.verbose('Update Definitions');

        this.vlocity.datapacksutils.dataPacksExpandedDefinition = this.vlocity.datapacksutils.updateExpandedDefinitionNamespace(this.vlocity.datapacksutils.dataPacksExpandedDefinition);

        await this.getPackageVersion();
        
    }
};

UtilityService.prototype.getPackageVersion = async function() {
    
    VlocityUtils.verbose('Get Package Version');

    if (!this.vlocity.packageVersion) {
        var result = await this.vlocity.jsForceConnection.query("SELECT DurableId, Id, IsSalesforce, MajorVersion, MinorVersion, Name, NamespacePrefix FROM Publisher where NamespacePrefix = \'" + this.vlocity.namespace + "\' LIMIT 1");

        this.vlocity.buildToolsVersionSettings = yaml.safeLoad(fs.readFileSync(path.join(__dirname, "buildToolsVersionSettings.yaml"), 'utf8'));

        this.vlocity.BuildToolSettingLatestVersion = this.vlocity.buildToolsVersionSettings.latest;

        if (!result || !result.records || result.records.length == 0) {
            this.vlocity.PackageVersion = "DeveloperOrg";
            this.vlocity.BuildToolSettingVersion = "latest";
        } else {
            this.vlocity.PackageVersion = result.records[0].MajorVersion + "." + result.records[0].MinorVersion;
            this.vlocity.PackageMajorVersion = result.records[0].MajorVersion;
            this.vlocity.PackageMinorVersion = result.records[0].MinorVersion;

            if (this.vlocity.buildToolsVersionSettings[this.vlocity.namespace]) {
                for (var i = 0; i < this.vlocity.buildToolsVersionSettings[this.vlocity.namespace].length; i++) {

                    var version = this.vlocity.buildToolsVersionSettings[this.vlocity.namespace][i];

                    if (this.vlocity.PackageMajorVersion > version.PackageMajorVersion) {
                        this.vlocity.BuildToolSettingVersion = version.version;
                        break;
                    } else if (this.vlocity.PackageMajorVersion == version.PackageMajorVersion) {
                        if (this.vlocity.PackageMinorVersion >= version.PackageMinorVersion) {
                            this.vlocity.BuildToolSettingVersion = version.version;
                            break;
                        }
                    }
                }

                if (!this.vlocity.BuildToolSettingVersion) {
                    this.vlocity.BuildToolSettingVersion = "latest";
                }
            }
        }
    }
};

UtilityService.prototype.describeSObject = async function(sObjectName) {
    var self = this;
    return await new Promise(function(resolve, reject) {
        self.vlocity.jsForceConnection.sobject(self.setNamespaceToOrg(sObjectName)).describe(function(err, result) {
            if (err) {
                VlocityUtils.verbose('Describe Not found', sObjectName, err.message);
            }

            resolve(self.setNamespaceToDefault(result));
        });
    });
};

UtilityService.prototype.getFieldsDefinitionsMap = function(sObjectDescribe) {
    var fieldsDefinitionMap = {};
    
    for (var field of sObjectDescribe.fields) {
        fieldsDefinitionMap[field.name] = field; 
    }

    return fieldsDefinitionMap;
};

UtilityService.prototype.getGitDiffsFromOrgToLocal = async function(jobInfo) {
    try {
        var vbtDeployKey = `VBTDeployKey${jobInfo.gitCheckKey ? jobInfo.gitCheckKey : ''}`;
        var hashKey = await this.getVlocitySetting(vbtDeployKey);

        var changedDataPacks = [];

        if (hashKey) {
            VlocityUtils.success('Git Hash', hashKey);

            var gitChanges = childProcess.execSync(`cd ${jobInfo.projectPath} && git diff --stat ${hashKey} --raw --no-renames`, { encoding: 'utf8' });

            VlocityUtils.success('Git Differences', gitChanges);

            var allPotentialFiles = [];

            if (gitChanges) {
                for (var line of gitChanges.split('\n')) {
                    try {
                        if (line.length > 0 && line[0] == ':') {
    
                            var changedFile = line.substring(32);
                        
                            if (changedFile) {
                                changedFile = changedFile.trimStart();
                                allPotentialFiles.push(changedFile);
                            }
                        }
                    } catch (e) {
                        VlocityUtils.error('Error Getting Filename', e);
                    }
                }    
            }

            var gitNewFiles = childProcess.execSync(`cd ${jobInfo.projectPath} && git ls-files --others --exclude-standard`, { encoding: 'utf8' });

            VlocityUtils.verbose('New Files', gitNewFiles);

            if (gitNewFiles) {
                for (var newfile of gitNewFiles.split('\n')) {
                    allPotentialFiles.push(newfile);
                }
            }

            for (var potentialFile of allPotentialFiles) {
                var splitFile = potentialFile.split('/');

                if (splitFile.length > 2 && splitFile[splitFile.length - 1].includes('.')) {
                    var dataPackKey = splitFile[splitFile.length - 3] + '/' + splitFile[splitFile.length - 2];

                    if (fs.existsSync(path.join(jobInfo.projectPath, jobInfo.expansionPath, dataPackKey)) && !changedDataPacks.includes(dataPackKey)) {
                        changedDataPacks.push(dataPackKey);
                    }
                }
            }

            VlocityUtils.success('Git Check', `Found Changes for ${changedDataPacks.length} DataPacks`, changedDataPacks);
            
            return changedDataPacks;
        } else {
            VlocityUtils.error('Git Hash Not Found');
        } 
    } catch (e) {
        VlocityUtils.error('Error Getting Diffs', e);
    }

    return null;
}

UtilityService.prototype.setVlocitySetting = async function(settingName, value) {
    try {    
        let result = await this.vlocity.jsForceConnection.query(`Select Id, ${this.vlocity.namespace}__Value__c from ${this.vlocity.namespace}__GeneralSettings__c where Name = '${settingName}'`);

        var settingsRecord = {};
        settingsRecord.Name = settingName;
        settingsRecord[`${this.vlocity.namespace}__Value__c`] = value;

        if (result && result.records.length != 0) {
            settingsRecord.Id = result.records[0].Id;
        }

        if (settingsRecord.Id) {
            VlocityUtils.verbose('Set Setting Update', await this.vlocity.jsForceConnection.sobject(`${this.vlocity.namespace}__GeneralSettings__c`).update([ settingsRecord ], {}));
        } else {
            VlocityUtils.verbose('Set Setting Insert', await this.vlocity.jsForceConnection.sobject(`${this.vlocity.namespace}__GeneralSettings__c`).insert([ settingsRecord ], {}));
        }
    } catch (e) {
        VlocityUtils.error('Set Settings Error', e);
    }

    return null;
}

UtilityService.prototype.getVlocitySetting = async function(settingName) {
    try {    
        let result = await this.vlocity.jsForceConnection.query(`Select ${this.vlocity.namespace}__Value__c from ${this.vlocity.namespace}__GeneralSettings__c where Name = '${settingName}'`);

        if (result && result.records.length != 0) {
            return result.records[0][`${this.vlocity.namespace}__Value__c`];
        }
    } catch (e) {
        VlocityUtils.error('Get Settings Error', e);
    }

    return null;
}

UtilityService.prototype.sfdx = async function(command, options) {

    if (!this.sfdxCommands) {

        this.sfdxCommands = {};
        
        for (var sfdxCommand of sfdx.commands) {

            if (sfdxCommand.command) {
                this.sfdxCommands[`${sfdxCommand.topic}:${sfdxCommand.command}`] = sfdxCommand.run;
            }
        }
    }

    options.quiet = VlocityUtils.quiet;
    options.loglevel = 'trace';
    return await this.sfdxCommands[command]({ flags: options });
}

UtilityService.prototype.updateCustomObject = async function(metadata) {
    return await this.updateMetadata('CustomObject', metadata);
};

UtilityService.prototype.retrieveCustomObject = async function(sObjectAPIName) {
    return await this.retrieveMetadata('CustomObject', sObjectAPIName);
};

UtilityService.prototype.updateGlobalValueSet = async function(metadata) {
    return await this.updateMetadata('GlobalValueSet', metadata);
};

UtilityService.prototype.retrieveGlobalValueSet = async function(sObjectAPIName) {
    return await this.retrieveMetadata('GlobalValueSet', sObjectAPIName);
};

UtilityService.prototype.retrieveMetadata = async function(type, component) {
    if (type && component) {
        component = this.vlocity.utilityservice.setNamespaceToOrg(component);

        var result = await this.vlocity.jsForceConnection.metadata.read(type, component, function(err, metadata) {
            if (err) { 
                VlocityUtils.error('Error Retrieve Metadata', err);
            }
        });

        return this.vlocity.utilityservice.setNamespaceToDefault(result);
    }
};

UtilityService.prototype.updateMetadata = async function(type, metadata) { 
    if (metadata && !this.isEmptyObject(metadata)) {
        metadata = this.vlocity.utilityservice.setNamespaceToOrg(metadata);
        
        var result = await this.vlocity.jsForceConnection.metadata.upsert(type, metadata, function(err, result) {
            if (err) {
                VlocityUtils.error('Error Update Metadata', err);
            }

            if (!(result instanceof Array)) {
                result = [result];
            }

            for (var res of result) {
                if (!res.success) {
                    VlocityUtils.error('Error Update Metadata', res.errors);
                }
            }
        });
    
        return this.vlocity.utilityservice.setNamespaceToDefault(result);
    }
};