package cmd

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/envkey/envkey/public/sdks/envkey-source/daemon"
	"github.com/envkey/envkey/public/sdks/envkey-source/env"
	"github.com/envkey/envkey/public/sdks/envkey-source/fetch"
	"github.com/envkey/envkey/public/sdks/envkey-source/parser"
	"github.com/envkey/envkey/public/sdks/envkey-source/shell"
	"github.com/envkey/envkey/public/sdks/envkey-source/utils"
	"github.com/envkey/envkey/public/sdks/envkey-source/version"
	"github.com/spf13/cobra"
	"gopkg.in/natefinch/lumberjack.v2"
)

var ClientLogEnabled = false
var execCmdArg = ""

var closed chan os.Signal

func run(cmd *cobra.Command, args []string, firstAttempt bool) {
	if printVersion {
		fmt.Println(version.Version)
		return
	}

	if killDaemon {
		daemon.Stop()
		return
	}

	if daemonMode {
		daemon.InlineStart(shouldCache)
		return
	}

	if shellHook != "" {
		shell.Hook(shellHook)
		return
	}

	if unset {
		fmt.Println(shell.Unload())
		return
	}

	initClientLogging()

	if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
		execCmdArg = strings.Join(args, " ")
	}

	if (clientNameArg != "" && clientVersionArg == "") ||
		(clientVersionArg != "" && clientNameArg == "") {
		utils.Fatal("if one of --client-name or --client-version is set, the other must also be set", execCmdArg != "")
	}

	var envkey string
	var appConfig env.AppConfig
	var overrides parser.EnvMap
	var err error
	/*
	* ENVKEY lookup order:
	* 	1 - Argument passed via command line
	*		2 - ENVKEY environment variable is set
	*		3 - .env file in current directory
	*		4 - .envkey config file in current directory {appId: string, orgId: string}
	*				+ file at ~/.envkey/apps/[appId].env (for local keys mainly)
	*	  5 - .env file at ~/.env
	 */

	envkey, appConfig, overrides = env.GetEnvkey(verboseOutput, envFileOverride, execCmdArg != "", localDevHost)

	if envkey == "" {
		if ignoreMissing {
			os.Exit(0)
		} else {
			utils.Fatal("ENVKEY missing\n", execCmdArg != "")
		}
	}

	if verboseOutput {
		fmt.Fprintln(os.Stderr, "loaded ENVKEY")
	}

	var clientName string
	var clientVersion string

	if clientNameArg != "" && clientVersion != "" {
		clientName = clientNameArg
		clientVersion = clientVersionArg
	} else {
		clientName = "envkey-source"
		clientVersion = version.Version
	}

	var res parser.EnvMap

	fetchOpts := fetch.FetchOptions{shouldCache, cacheDir, clientName, clientVersion, verboseOutput, timeoutSeconds, retries, retryBackoff}

	if memCache || onChangeCmdArg != "" || (execCmdArg != "" && watch) {
		daemon.LaunchDetachedIfNeeded(daemon.DaemonOptions{
			verboseOutput,
			shouldCache,
		})
		res, _, err = daemon.FetchMap(envkey, clientName, clientVersion, rollingReload, rollingPct, watchThrottle)

		if err != nil {
			res, err = fetch.FetchMap(envkey, fetchOpts)
		}
	} else {
		res, err = fetch.FetchMap(envkey, fetchOpts)
	}

	if err != nil && err.Error() == "ENVKEY invalid" && appConfig.AppId != "" && firstAttempt {
		// clear out incorrect ENVKEY and try again
		env.ClearAppEnvkey(appConfig.AppId)
		run(cmd, args, false)
		return
	}

	utils.CheckError(err, execCmdArg != "")

	closed = make(chan os.Signal)
	signal.Notify(closed, os.Interrupt, syscall.SIGTERM)

	go func() {
		sig := <-closed
		// stderrLogger.Println(utils.FormatTerminal(" | received "+sig.String()+" signal--cleaning up and exiting", nil))
		log.Println("Received " + sig.String() + " signal. Cleaning up and exiting.")
		if sig == os.Interrupt {
			killWatchCommandIfRunning(syscall.SIGINT)
		} else if sig == syscall.SIGTERM {
			killWatchCommandIfRunning(syscall.SIGTERM)
		}

		os.Exit(0)
	}()

	for k, v := range overrides {
		if k != "ENVKEY" {
			res[k] = v
		}
	}

	for k, _ := range res {
		if os.Getenv(k) != "" {
			res[k] = os.Getenv(k)
		}
	}

	execWithEnv(envkey, res, clientName, clientVersion)
}

func initClientLogging() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}

	logDir := filepath.Join(home, ".envkey", "logs")
	err = os.MkdirAll(logDir, os.ModePerm)
	if err != nil {
		return
	}

	log.SetOutput(&lumberjack.Logger{
		Filename:   filepath.Join(logDir, "envkey-source-client.log"),
		MaxSize:    25, // megabytes
		MaxBackups: 3,
		MaxAge:     30, //days
		Compress:   false,
	})

	ClientLogEnabled = true
}
