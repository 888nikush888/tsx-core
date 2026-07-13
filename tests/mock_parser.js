const mockXml = `
<signal>
    <action>SHORT</action>
    <pair>HYPEUSDT</pair>
    <entry_range>
        <min>68.60</min>
        <max>70.07</max>
    </entry_range>
    <targets>
        <target id="1">67.32</target>
        <target id="2">65.95</target>
    </targets>
    <stoploss>70.97</stoploss>
    <leverage>15</leverage>
</signal>
`;

console.log(mockXml.trim());
process.exit(0);
