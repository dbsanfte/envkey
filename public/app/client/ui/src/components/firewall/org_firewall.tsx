import React, { useState, useLayoutEffect, useEffect } from "react";
import { OrgComponent, ReactSelectOption } from "@ui_types";
import { Api } from "@core/types";
import * as g from "@core/lib/graph";
import * as R from "ramda";
import * as ui from "@ui";
import * as styles from "@styles";
import { isValidIPOrCIDR } from "@core/lib/utils/ip";
import { SmallLoader, SvgImage } from "@images";
import { logAndAlertError } from "@ui_lib/errors";
import copyToClipboard from "copy-text-to-clipboard";

export const OrgFirewall: OrgComponent = (props) => {
  const { graph, graphUpdatedAt } = props.core;
  const org = g.getOrg(graph);
  const currentUserId = props.ui.loadedAccountId!;

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const [updating, setUpdating] = useState(false);

  const [localIpsAllowed, setLocalIpsAllowed] = useState(org.localIpsAllowed);
  const [localInputVal, setLocalInputVal] = useState("");

  const [environmentRoleIpsAllowed, setEnvironmentRolesIpsAllowed] = useState<
    Record<string, string[] | undefined>
  >(org.environmentRoleIpsAllowed ?? {});

  const [environmentRoleInputVals, setEnvironmentRolesInputVals] = useState<
    Record<string, string>
  >({});

  const hasUpdate = !(
    R.equals(localIpsAllowed, org.localIpsAllowed) &&
    R.equals(environmentRoleIpsAllowed, org.environmentRoleIpsAllowed ?? {})
  );

  const onSubmit = async () => {
    if (!hasUpdate) {
      return;
    }
    setUpdating(true);
    await props.dispatch({
      type: Api.ActionType.SET_ORG_ALLOWED_IPS,
      payload: {
        localIpsAllowed,
        environmentRoleIpsAllowed,
      },
    });
  };

  useEffect(() => {
    if (props.core.updateFirewallErrors[org.id]) {
      const error = props.core.updateFirewallErrors[org.id].error;

      console.log(props.core.updateFirewallErrors[org.id]);

      if (typeof error == "object") {
        switch (error.message) {
          case "Current user IP not allowed by localIpsAllowed":
            alert(
              "Error: Your UI/CLI trusted IPs must include your current IP address (otherwise you'd be locked out)."
            );
            break;

          default:
            logAndAlertError(
              "There was a problem updating trusted IPs.",
              error
            );
        }
      }
    }
  }, [props.core.updateFirewallErrors[org.id]]);

  useEffect(() => {
    if (updating && !props.core.isUpdatingFirewall[org.id]) {
      setUpdating(false);
    }
  }, [props.core.isUpdatingFirewall[org.id]]);

  return (
    <div className={styles.OrgContainer}>
      <h3>
        {updating ? <SmallLoader /> : ""}
        Org <strong>Firewall</strong>
      </h3>

      {hasUpdate && !updating ? (
        <span className="unsaved-changes">Unsaved changes</span>
      ) : (
        ""
      )}

      <p>Determines which IPs can access the organization's config.</p>

      <p>
        Add any number of valid IPV4/IPV6 IPs and/or CIDR ranges (example:
        '192.12.24.123' or '172.18.0.0/24').
      </p>

      <p>Firewall settings can be extended or ovewritten on a per-app basis.</p>

      <div className="field">
        <h4>UI/CLI Trusted IPs</h4>
        <p>
          Controls which IPs can acces the EnvKey host API from the EnvKey UI or
          CLI for this org.
        </p>
        <ui.ReactSelect
          creatable={true}
          isMulti
          bgStyle="light"
          hideIndicatorContainer={true}
          noOptionsMessage={() => null}
          inputValue={localInputVal}
          onInputChange={(newValue: string) => {
            const split = R.uniq(newValue.split(/(?:\s|\n|\r|,)+/));
            if (split.length > 1 && split.every(isValidIPOrCIDR)) {
              setLocalIpsAllowed(split);
              setLocalInputVal("");
            } else {
              setLocalInputVal(newValue);
            }
          }}
          onChange={(selectedArg) => {
            const selected = (selectedArg ?? []) as ReactSelectOption[];

            let ips = R.uniq(
              selected.map(R.prop("value")).filter(isValidIPOrCIDR)
            );

            if (
              !R.equals(
                R.sortBy(R.identity, localIpsAllowed ?? []),
                R.sortBy(R.identity, ips)
              )
            ) {
              setLocalIpsAllowed(ips.length > 0 ? ips : undefined);
            }
          }}
          value={(localIpsAllowed ?? []).map((value) => ({
            value,
            label: value,
          }))}
          placeholder="Any IP"
          formatCreateLabel={(s: string) => s}
          isValidNewOption={(s) => isValidIPOrCIDR(s)}
        />
        {(localIpsAllowed ?? []).length > 0 ? (
          <button
            title="Copy"
            className="small-copy"
            onClick={() => copyToClipboard(localIpsAllowed!.join(", "))}
          >
            <SvgImage type="copy" width={25} height={25} />
          </button>
        ) : (
          ""
        )}
      </div>

      {g
        .graphTypes(graph)
        .environmentRoles.map(({ id: environmentRoleId, name }) => (
          <div className="field">
            <h4>{name} Trusted IPs</h4>
            <p>Controls which IPs can load {name} server ENVKEYs.</p>

            <ui.ReactSelect
              creatable={true}
              isMulti
              hideIndicatorContainer={true}
              noOptionsMessage={() => null}
              bgStyle="light"
              inputValue={environmentRoleInputVals[environmentRoleId] ?? ""}
              onInputChange={(newValue: string) => {
                const split = R.uniq(newValue.split(/(?:\s|\n|\r|,)+/));
                if (split.length > 1 && split.every(isValidIPOrCIDR)) {
                  setEnvironmentRolesIpsAllowed({
                    ...environmentRoleIpsAllowed,
                    [environmentRoleId]: split,
                  });
                  setEnvironmentRolesInputVals({
                    ...environmentRoleInputVals,
                    [environmentRoleId]: "",
                  });
                } else {
                  setEnvironmentRolesInputVals({
                    ...environmentRoleInputVals,
                    [environmentRoleId]: newValue,
                  });
                }
              }}
              onChange={(selectedArg) => {
                const selected = (selectedArg ?? []) as ReactSelectOption[];

                let ips = R.uniq(
                  selected.map(R.prop("value")).filter(isValidIPOrCIDR)
                );

                if (
                  !R.equals(
                    R.sortBy(
                      R.identity,
                      environmentRoleIpsAllowed?.[environmentRoleId] ?? []
                    ),
                    R.sortBy(R.identity, ips)
                  )
                ) {
                  setEnvironmentRolesIpsAllowed(
                    ips.length > 0
                      ? {
                          ...environmentRoleIpsAllowed,
                          [environmentRoleId]: ips,
                        }
                      : R.omit([environmentRoleId], environmentRoleIpsAllowed)
                  );
                }
              }}
              value={(environmentRoleIpsAllowed?.[environmentRoleId] ?? []).map(
                (value) => ({
                  value,
                  label: value,
                })
              )}
              placeholder="Any IP"
              formatCreateLabel={(s: string) => s}
              isValidNewOption={(s) => isValidIPOrCIDR(s)}
            />
            {(environmentRoleIpsAllowed?.[environmentRoleId] ?? []).length >
            0 ? (
              <button
                title="Copy"
                className="small-copy"
                onClick={() =>
                  copyToClipboard(
                    environmentRoleIpsAllowed?.[environmentRoleId]!.join(", ")
                  )
                }
              >
                <SvgImage type="copy" width={25} height={25} />
              </button>
            ) : (
              ""
            )}
          </div>
        ))}

      <div className="buttons">
        {updating ? (
          <SmallLoader />
        ) : (
          <button className="primary" disabled={!hasUpdate} onClick={onSubmit}>
            Update
          </button>
        )}
      </div>
    </div>
  );
};
